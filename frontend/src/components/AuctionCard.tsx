"use client";

import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import AuctionStatus from "./AuctionStatus";

interface AuctionAccount {
  title: string;
  description: string;
  creator: PublicKey;
  endTime: BN;
  bidCount: number;
  status: Record<string, unknown>;
}

interface Props {
  pubkey: string;
  account: AuctionAccount;
  isOwn?: boolean;
  hasBid?: boolean;
}

export default function AuctionCard({ pubkey, account, isOwn, hasBid }: Props) {
  const shortKey = pubkey.slice(0, 6) + "…" + pubkey.slice(-4);

  return (
    <Link href={`/auction/${pubkey}`} className="block h-full">
      <div className="group flex flex-col h-full bg-doma-card border border-white/10 rounded-2xl overflow-hidden hover:border-doma-blue/20 hover:shadow-glow-blue transition-all backdrop-blur-md cursor-pointer">
        <div className="flex flex-col flex-1 p-5">
          {/* Title + status */}
          <div className="flex items-start justify-between gap-2 mb-2">
            <h2 className="text-white font-semibold text-base leading-snug group-hover:text-doma-blue transition-colors">
              {account.title}
            </h2>
            <AuctionStatus status={account.status} endTime={account.endTime} />
          </div>

          {/* Description */}
          <p className="text-white/40 text-sm line-clamp-2 mb-4 flex-1 leading-relaxed">
            {account.description}
          </p>

          {/* Footer */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/40">
                {account.bidCount} {account.bidCount === 1 ? "bid" : "bids"}
              </span>
              {isOwn && (
                <span className="text-xs bg-doma-blue/10 text-doma-blue border border-doma-blue/20 px-1.5 py-0.5 rounded font-medium">
                  Yours
                </span>
              )}
              {hasBid && !isOwn && (
                <span className="text-xs bg-emerald-900/20 text-emerald-400 border border-emerald-700/40 px-1.5 py-0.5 rounded font-medium">
                  Bid placed
                </span>
              )}
            </div>
            <span className="text-xs text-white/20 font-mono">{shortKey}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
