"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
import { useAnchorProgram } from "@/lib/program";
import { getCreditAccountPda, getBidRecordPda } from "@/lib/pda";
import { PROGRAM_ID } from "@/lib/constants";

export function useRefundCredit() {
  const ctx = useAnchorProgram();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (auctionPubkey: string) => {
      if (!ctx) throw new Error("Wallet not connected");
      const { program, provider } = ctx;
      const user = provider.wallet.publicKey;
      const auctionKey = new PublicKey(auctionPubkey);
      const [creditAccount] = getCreditAccountPda(user, PROGRAM_ID);
      const [bidRecord] = getBidRecordPda(user, auctionKey, PROGRAM_ID);

      await program.methods
        .refundCredit()
        .accountsPartial({
          user,
          creditAccount,
          bidRecord,
          auction: auctionKey,
        })
        .rpc({ commitment: "confirmed" });

      return { userKey: user.toBase58(), auctionPubkey };
    },
    onSuccess: ({ userKey, auctionPubkey }) => {
      queryClient.invalidateQueries({ queryKey: ["credits", userKey] });
      queryClient.invalidateQueries({ queryKey: ["auction", auctionPubkey] });
      queryClient.invalidateQueries({ queryKey: ["bid-record", auctionPubkey] });
    },
  });
}
