"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SystemProgram } from "@solana/web3.js";
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
import { getAuctionPda, compDefOffsetNum } from "@/lib/pda";
import { PROGRAM_ID, CLUSTER_OFFSET } from "@/lib/constants";

export interface CreateAuctionArgs {
  title: string;
  description: string;
  endTime: number; // unix timestamp
}

export function useCreateAuction() {
  const ctx = useAnchorProgram();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ title, description, endTime }: CreateAuctionArgs) => {
      if (!ctx) throw new Error("Wallet not connected");
      const { program, provider } = ctx;
      const payer = provider.wallet.publicKey;

      const nonce = new BN(Array.from(randomBytes(8)));
      const [auctionPda] = getAuctionPda(payer, nonce, PROGRAM_ID);

      // Step 1: create_auction
      await program.methods
        .createAuction(nonce, title, description, new BN(endTime))
        .accountsPartial({
          creator: payer,
          auction: auctionPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed", skipPreflight: true });

      // Step 2: init_auction_mpc
      const computationOffset = new BN(Array.from(randomBytes(8)));
      await program.methods
        .initAuctionMpc(computationOffset)
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
            compDefOffsetNum("init_auction_state")
          ),
          auction: auctionPda,
        })
        .rpc({ commitment: "confirmed", skipPreflight: true });

      await awaitComputationFinalization(
        provider,
        computationOffset,
        PROGRAM_ID,
        "confirmed",
        300_000
      );

      return { auctionPda: auctionPda.toBase58() };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auctions"] });
    },
  });
}
