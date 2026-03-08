"use client";

import { useQuery } from "@tanstack/react-query";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getBidRecordPda } from "@/lib/pda";
import { PROGRAM_ID } from "@/lib/constants";

/**
 * Batch-checks BidRecord PDAs for every auction in the list.
 * Returns a Set of auction pubkeys (base58) where the connected wallet has a bid.
 */
export function useMyBids(auctionPubkeys: string[]) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const sortedKeys = [...auctionPubkeys].sort();

  return useQuery({
    queryKey: ["my-bids", publicKey?.toBase58(), sortedKeys],
    enabled: !!publicKey && auctionPubkeys.length > 0,
    refetchInterval: 10_000,
    queryFn: async (): Promise<Set<string>> => {
      if (!publicKey) return new Set();
      const pdas = auctionPubkeys.map((pk) => {
        const [bidRecordPda] = getBidRecordPda(
          publicKey,
          new PublicKey(pk),
          PROGRAM_ID
        );
        return bidRecordPda;
      });
      const infos = await connection.getMultipleAccountsInfo(pdas);
      const result = new Set<string>();
      infos.forEach((info, i) => {
        if (info !== null) result.add(auctionPubkeys[i]);
      });
      return result;
    },
  });
}
