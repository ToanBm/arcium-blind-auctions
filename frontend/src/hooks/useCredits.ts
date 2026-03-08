"use client";

import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { useAnchorProgram } from "@/lib/program";
import { getCreditAccountPda } from "@/lib/pda";
import { PROGRAM_ID } from "@/lib/constants";

export function useCredits() {
  const { publicKey } = useWallet();
  const ctx = useAnchorProgram();

  return useQuery({
    queryKey: ["credits", publicKey?.toBase58()],
    enabled: !!publicKey && !!ctx,
    refetchInterval: 5000,
    queryFn: async () => {
      if (!publicKey || !ctx) return null;
      const [pda] = getCreditAccountPda(publicKey, PROGRAM_ID);
      const account = await (ctx.program.account as any).creditAccount.fetchNullable(pda);
      if (!account) return { balance: 0, hasCreditAccount: false };
      return { balance: (account.balance as { toNumber(): number }).toNumber(), hasCreditAccount: true };
    },
  });
}
