"use client";

import { useQuery } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
import { useAnchorProgram } from "@/lib/program";

export function useAuction(pubkey: string | null) {
  const ctx = useAnchorProgram();

  return useQuery({
    queryKey: ["auction", pubkey],
    enabled: !!ctx && !!pubkey,
    queryFn: async () => {
      if (!ctx || !pubkey) return null;
      return ctx.program.account.auction.fetch(new PublicKey(pubkey));
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status as Record<string, unknown> | undefined;
      if (!status) return 3_000;
      if ("closed" in status) return 2_000;   // MPC computing — poll fast
      if ("finalized" in status) return 10_000; // stable, slow down
      return 5_000;                             // active
    },
  });
}
