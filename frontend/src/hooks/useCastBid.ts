"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import { randomBytes } from "@noble/hashes/utils";
import {
  getMXEAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getCompDefAccAddress,
  awaitComputationFinalization,
} from "@arcium-hq/client";
import { useAnchorProgram } from "@/lib/program";
import { getBidRecordPda, getBidVaultPda, getCreditAccountPda, compDefOffsetNum } from "@/lib/pda";
import { encryptBid } from "@/lib/encrypt";
import { PROGRAM_ID, CLUSTER_OFFSET } from "@/lib/constants";

export interface CastBidArgs {
  auctionPubkey: string;
  /** Bid amount in lamports. Deposited as SOL escrow and used as the MPC ceiling. */
  ceiling: bigint;
}

export function useCastBid() {
  const ctx = useAnchorProgram();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ auctionPubkey, ceiling }: CastBidArgs) => {
      if (!ctx) throw new Error("Wallet not connected");
      const { program, provider } = ctx;
      const payer = provider.wallet.publicKey;
      const auctionKey = new PublicKey(auctionPubkey);

      // Encrypt the bid amount (same value as the on-chain ceiling).
      const { ciphertext, pubKey, nonceBN } = await encryptBid(
        provider,
        ceiling
      );

      const computationOffset = new BN(Array.from(randomBytes(8)));
      const [bidRecordPda] = getBidRecordPda(payer, auctionKey, PROGRAM_ID);
      const [bidVaultPda] = getBidVaultPda(payer, auctionKey, PROGRAM_ID);
      const [creditAccountPda] = getCreditAccountPda(payer, PROGRAM_ID);
      const ceilingBN = new BN(ceiling.toString());

      await program.methods
        .castBid(computationOffset, ceilingBN, ciphertext, pubKey, nonceBN)
        .accountsPartial({
          payer,
          mxeAccount: getMXEAccAddress(PROGRAM_ID),
          computationAccount: getComputationAccAddress(
            CLUSTER_OFFSET,
            computationOffset
          ),
          clusterAccount: getClusterAccAddress(CLUSTER_OFFSET),
          mempoolAccount: getMempoolAccAddress(CLUSTER_OFFSET),
          executingPool: getExecutingPoolAccAddress(CLUSTER_OFFSET),
          compDefAccount: getCompDefAccAddress(
            PROGRAM_ID,
            compDefOffsetNum("submit_bid")
          ),
          auction: auctionKey,
          bidVault: bidVaultPda,
          bidRecord: bidRecordPda,
          creditAccount: creditAccountPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed", skipPreflight: true });

      await awaitComputationFinalization(
        provider,
        computationOffset,
        PROGRAM_ID,
        "confirmed",
        300_000
      );

      return { sig: "ok" };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["auction", variables.auctionPubkey],
      });
      queryClient.invalidateQueries({ queryKey: ["auctions"] });
    },
  });
}
