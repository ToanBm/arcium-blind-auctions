"use client";

import Link from "next/link";
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useAuctions } from "@/hooks/useAuctions";
import { useMyBids } from "@/hooks/useMyBids";
import AuctionCard from "@/components/AuctionCard";
import WalletButton from "@/components/WalletButton";

type Filter = "all" | "mine" | "bids";

export default function Home() {
  const { publicKey } = useWallet();
  const { data: auctions, isLoading, error } = useAuctions();
  const [filter, setFilter] = useState<Filter>("all");

  const allPubkeys = auctions?.map((a) => a.publicKey.toBase58()) ?? [];
  const { data: myBidSet } = useMyBids(allPubkeys);

  const filtered = auctions?.filter(({ publicKey: pk, account }) => {
    if (filter === "mine") return account.creator.toBase58() === publicKey?.toBase58();
    if (filter === "bids") return myBidSet?.has(pk.toBase58()) ?? false;
    return true;
  });

  const counts = {
    all: auctions?.length ?? 0,
    mine: auctions?.filter((a) => a.account.creator.toBase58() === publicKey?.toBase58()).length ?? 0,
    bids: myBidSet?.size ?? 0,
  };

  if (!publicKey) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-6 animate-fade-in">
        <div className="w-20 h-20 rounded-full bg-doma-blue/10 border border-doma-blue/20 flex items-center justify-center text-4xl shadow-glow-blue">
          🔒
        </div>
        <div className="text-center">
          <h2 className="text-2xl font-bold text-white mb-2">
            Privacy-Preserving Blind Auctions
          </h2>
          <p className="text-white/50 max-w-md leading-relaxed text-sm">
            Submit encrypted bids on-chain. The Arcium MPC network privately
            computes the winner using Vickrey (second-price) logic — no one
            sees your bid.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-4 max-w-sm w-full text-center">
          {[
            { icon: "🔒", label: "Encrypted bids" },
            { icon: "🏆", label: "Vickrey pricing" },
            { icon: "🌐", label: "MPC reveal" },
          ].map(({ icon, label }) => (
            <div
              key={label}
              className="bg-doma-card border border-white/10 rounded-xl p-3 backdrop-blur-sm"
            >
              <div className="text-xl mb-1">{icon}</div>
              <p className="text-xs text-white/50">{label}</p>
            </div>
          ))}
        </div>
        <WalletButton />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4">
        <div className="bg-doma-card border border-white/10 rounded-[20px] p-1 flex items-center gap-1">
          {(["all", "mine", "bids"] as Filter[]).map((id) => (
            <button
              key={id}
              onClick={() => setFilter(id)}
              className={`px-4 py-2 rounded-[14px] text-sm font-bold transition-all flex items-center gap-2 ${
                filter === id
                  ? "bg-doma-blue/10 text-doma-blue"
                  : "text-white/50 hover:text-white hover:bg-white/5"
              }`}
            >
              {id === "all" ? "All" : id === "mine" ? "Mine" : "My Bids"}
              <span
                className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                  filter === id
                    ? "bg-doma-blue/20 text-doma-blue"
                    : "bg-white/5 text-white/30"
                }`}
              >
                {counts[id]}
              </span>
            </button>
          ))}
        </div>

        <Link
          href="/create"
          className="flex items-center gap-2 px-5 py-2.5 rounded-[14px] bg-doma-blue hover:bg-white text-doma-dark font-bold text-sm transition-all transform hover:scale-105 shadow-glow-blue"
        >
          <span>+</span>
          <span>New Auction</span>
        </Link>
      </div>

      {/* Content */}
      {isLoading && (
        <div className="flex items-center justify-center py-16 gap-3 text-white/40">
          <div className="w-5 h-5 border-2 border-white/20 border-t-doma-blue rounded-full animate-spin" />
          <span className="text-sm">Loading auctions…</span>
        </div>
      )}

      {error && (
        <div className="text-center py-8 rounded-2xl bg-red-900/10 border border-red-800/30 text-red-400 text-sm">
          Failed to load auctions. Check your connection.
        </div>
      )}

      {!isLoading && !error && filtered && filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-white/40">
          <span className="text-4xl">🔒</span>
          <p className="text-sm">
            {filter === "all" ? (
              <>
                No auctions yet.{" "}
                <Link href="/create" className="text-doma-blue hover:underline">
                  Create one
                </Link>
              </>
            ) : filter === "mine" ? (
              "You haven't created any auctions yet."
            ) : (
              "You haven't placed any bids yet."
            )}
          </p>
        </div>
      )}

      {!isLoading && filtered && filtered.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(({ publicKey: pk, account }) => (
            <AuctionCard
              key={pk.toBase58()}
              pubkey={pk.toBase58()}
              account={account}
              isOwn={account.creator.toBase58() === publicKey?.toBase58()}
              hasBid={myBidSet?.has(pk.toBase58()) ?? false}
            />
          ))}
        </div>
      )}
    </div>
  );
}
