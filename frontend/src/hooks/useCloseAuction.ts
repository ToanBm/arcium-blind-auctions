"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
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
import { compDefOffsetNum } from "@/lib/pda";
import { PROGRAM_ID, CLUSTER_OFFSET } from "@/lib/constants";

export function useCloseAuction() {
  const ctx = useAnchorProgram();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (auctionPubkey: string) => {
      if (!ctx) throw new Error("Wallet not connected");
      const { program, provider } = ctx;
      const payer = provider.wallet.publicKey;
      const auctionKey = new PublicKey(auctionPubkey);

      const computationOffset = new BN(Array.from(randomBytes(8)));

      await program.methods
        .closeAuction(computationOffset)
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
            compDefOffsetNum("reveal_winner")
          ),
          auction: auctionKey,
        })
        .rpc({ commitment: "confirmed", skipPreflight: true });

      await awaitComputationFinalization(
        provider,
        computationOffset,
        PROGRAM_ID,
        "confirmed",
        300_000
      );
    },
    onSuccess: (_data, auctionPubkey) => {
      queryClient.invalidateQueries({ queryKey: ["auction", auctionPubkey] });
      queryClient.invalidateQueries({ queryKey: ["auctions"] });
    },
  });
}
