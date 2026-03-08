"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { useAnchorProgram } from "@/lib/program";
import { getBidRecordPda, getBidVaultPda } from "@/lib/pda";
import { PROGRAM_ID } from "@/lib/constants";

export function useSettleAuction() {
  const ctx = useAnchorProgram();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      auctionPubkey,
      creatorPubkey,
      winnerPubkey,
    }: {
      auctionPubkey: string;
      creatorPubkey: string;
      winnerPubkey: string;
    }) => {
      if (!ctx) throw new Error("Wallet not connected");
      const { program, provider } = ctx;
      const payer = provider.wallet.publicKey;
      const auctionKey = new PublicKey(auctionPubkey);
      const creatorKey = new PublicKey(creatorPubkey);
      const winnerKey = new PublicKey(winnerPubkey);

      const [bidRecordPda] = getBidRecordPda(winnerKey, auctionKey, PROGRAM_ID);
      const [bidVaultPda] = getBidVaultPda(winnerKey, auctionKey, PROGRAM_ID);

      await program.methods
        .settleAuction()
        .accountsPartial({
          payer,
          creator: creatorKey,
          winner: winnerKey,
          auction: auctionKey,
          bidRecord: bidRecordPda,
          bidVault: bidVaultPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed", skipPreflight: true });

      return { ok: true };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["auction", variables.auctionPubkey] });
      queryClient.invalidateQueries({ queryKey: ["bid-record", variables.auctionPubkey] });
    },
  });
}
