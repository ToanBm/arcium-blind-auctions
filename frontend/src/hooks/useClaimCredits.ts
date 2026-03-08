"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import { useAnchorProgram } from "@/lib/program";
import { getCreditAccountPda } from "@/lib/pda";
import { PROGRAM_ID } from "@/lib/constants";

export function useClaimCredits() {
  const ctx = useAnchorProgram();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (amount: number = 3) => {
      if (!ctx) throw new Error("Wallet not connected");
      const { program, provider } = ctx;
      const user = provider.wallet.publicKey;
      const [creditAccount] = getCreditAccountPda(user, PROGRAM_ID);

      await program.methods
        .claimCredits(new BN(amount))
        .accountsPartial({
          user,
          creditAccount,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

      return user.toBase58();
    },
    onSuccess: (userKey) => {
      queryClient.invalidateQueries({ queryKey: ["credits", userKey] });
    },
  });
}
