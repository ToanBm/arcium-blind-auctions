"use client";

import { useQuery } from "@tanstack/react-query";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getBidRecordPda } from "@/lib/pda";
import { PROGRAM_ID } from "@/lib/constants";

export interface BidRecord {
  slotIdx: number;
  creditRefunded: boolean;
  settled: boolean;
  escrowWithdrawn: boolean;
}

// BidRecord layout (86 bytes):
//   8 disc | 32 bidder | 32 auction | 1 slot_idx | 8 ceiling
//   | 1 vault_bump | 1 credit_refunded | 1 settled | 1 escrow_withdrawn | 1 bump
export function useBidRecord(auctionPubkey: string | null) {
  const { publicKey } = useWallet();
  const { connection } = useConnection();

  return useQuery({
    queryKey: ["bid-record", auctionPubkey, publicKey?.toBase58()],
    enabled: !!publicKey && !!auctionPubkey,
    queryFn: async (): Promise<BidRecord | null> => {
      if (!publicKey || !auctionPubkey) return null;
      const [pda] = getBidRecordPda(publicKey, new PublicKey(auctionPubkey), PROGRAM_ID);
      const info = await connection.getAccountInfo(pda);
      if (!info) return null;
      return {
        slotIdx: info.data[72],
        creditRefunded: info.data[82] === 1,
        settled: info.data[83] === 1,
        escrowWithdrawn: info.data[84] === 1,
      };
    },
    // Refresh every 5s until all actions are done
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return 5_000;
      if (d.settled && d.escrowWithdrawn && d.creditRefunded) return false;
      return 5_000;
    },
  });
}
