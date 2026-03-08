"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { useAnchorProgram } from "@/lib/program";
import { getBidRecordPda, getBidVaultPda } from "@/lib/pda";
import { PROGRAM_ID } from "@/lib/constants";

export function useWithdrawEscrow() {
  const ctx = useAnchorProgram();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      auctionPubkey,
    }: {
      auctionPubkey: string;
    }) => {
      if (!ctx) throw new Error("Wallet not connected");
      const { program, provider } = ctx;
      const bidder = provider.wallet.publicKey;
      const auctionKey = new PublicKey(auctionPubkey);

      const [bidRecordPda] = getBidRecordPda(bidder, auctionKey, PROGRAM_ID);
      const [bidVaultPda] = getBidVaultPda(bidder, auctionKey, PROGRAM_ID);

      await program.methods
        .withdrawEscrow()
        .accountsPartial({
          bidder,
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
