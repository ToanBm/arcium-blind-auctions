"use client";

import { useQuery } from "@tanstack/react-query";
import { useAnchorProgram } from "@/lib/program";

export function useAuctions() {
  const ctx = useAnchorProgram();

  return useQuery({
    queryKey: ["auctions"],
    enabled: !!ctx,
    refetchInterval: 5000,
    queryFn: async () => {
      if (!ctx) return [];
      return ctx.program.account.auction.all();
    },
  });
}
