"use client";

import { use } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import type BN from "bn.js";
import { type PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { useAuction } from "@/hooks/useAuction";
import { useCloseAuction } from "@/hooks/useCloseAuction";
import AuctionStatus from "@/components/AuctionStatus";
import BidForm from "@/components/BidForm";
import RevealPanel from "@/components/RevealPanel";
import { useRefundCredit } from "@/hooks/useRefundCredit";
import { useBidRecord } from "@/hooks/useBidRecord";
import { useState } from "react";

interface PageProps {
  params: Promise<{ pubkey: string }>;
}

export default function AuctionPage({ params }: PageProps) {
  const { pubkey } = use(params);
  const { publicKey } = useWallet();
  const { data: auction, isLoading, error } = useAuction(pubkey);
  const { data: bidRecord } = useBidRecord(pubkey);
  const closeAuction = useCloseAuction();
  const refundCredit = useRefundCredit();
  const [closeError, setCloseError] = useState<string | null>(null);

  const alreadyBid = bidRecord !== null && bidRecord !== undefined;
  const bidSlotIdx = bidRecord?.slotIdx ?? null;
  const creditRefunded = bidRecord?.creditRefunded ?? false;
  const bidSettled = bidRecord?.settled ?? false;
  const escrowWithdrawn = bidRecord?.escrowWithdrawn ?? false;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 gap-3 text-white/40">
        <div className="w-5 h-5 border-2 border-white/20 border-t-doma-blue rounded-full animate-spin" />
        <span className="text-sm">Loading auction…</span>
      </div>
    );
  }

  if (error || !auction) {
    return (
      <div className="text-center py-16 rounded-2xl bg-red-900/10 border border-red-800/30 text-red-400 text-sm">
        Auction not found or failed to load.
      </div>
    );
  }

  const isCreator = publicKey?.toBase58() === auction.creator.toBase58();
  const isActive = "active" in (auction.status as Record<string, unknown>);
  const isClosed = "closed" in (auction.status as Record<string, unknown>);
  const isFinalized = "finalized" in (auction.status as Record<string, unknown>);
  const winnerIdx = auction.winnerIdx as number | null;
  const isWinner = isFinalized && bidSlotIdx !== null && winnerIdx !== null && bidSlotIdx === winnerIdx;
  const endTimeSec = auction.endTime.toNumber();
  const isPastDeadline = Date.now() / 1000 > endTimeSec;

  async function handleClose() {
    setCloseError(null);
    try {
      await closeAuction.mutateAsync(pubkey);
    } catch (err: unknown) {
      setCloseError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Back */}
      <Link href="/" className="text-white/30 hover:text-white transition-colors text-sm">
        ← All Auctions
      </Link>

      {/* Header card */}
      <div className="bg-doma-card border border-white/10 rounded-2xl p-5 backdrop-blur-md">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <h1 className="text-xl font-bold text-white">{auction.title}</h1>
            <p className="text-white/30 text-xs mt-1 font-mono">
              {pubkey.slice(0, 12)}…{pubkey.slice(-6)}
            </p>
          </div>
          <AuctionStatus
            status={auction.status as Record<string, unknown>}
            endTime={auction.endTime}
          />
        </div>
        <p className="text-white/50 text-sm leading-relaxed">{auction.description}</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-doma-card border border-white/10 rounded-2xl p-4 backdrop-blur-md">
          <div className="text-white/40 text-xs mb-1">Total Bids</div>
          <div className="text-white text-2xl font-bold">{auction.bidCount}</div>
        </div>
        <div className="bg-doma-card border border-white/10 rounded-2xl p-4 backdrop-blur-md">
          <div className="text-white/40 text-xs mb-1">Deadline</div>
          <div className="text-white text-sm font-medium">
            {new Date(endTimeSec * 1000).toLocaleString()}
          </div>
        </div>
      </div>

      {/* Bid form */}
      {publicKey && isActive && !isClosed && !isFinalized && (
        <BidForm
          auctionPubkey={pubkey}
          disabled={alreadyBid || isPastDeadline}
          disabledReason={
            alreadyBid
              ? "You already submitted a bid for this auction."
              : "Auction deadline has passed."
          }
        />
      )}

      {/* Close button — creator after deadline */}
      {publicKey && isCreator && isActive && isPastDeadline && (
        <div className="space-y-3">
          <button
            onClick={handleClose}
            disabled={closeAuction.isPending}
            className="w-full px-5 py-2.5 rounded-[14px] bg-doma-blue hover:bg-white text-doma-dark font-bold text-sm transition-all transform hover:scale-105 shadow-glow-blue disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none"
          >
            {closeAuction.isPending ? "Computing winner via MPC…" : "Close Auction & Reveal Winner"}
          </button>
          {closeAuction.isPending && (
            <div className="flex items-center gap-2 justify-center text-xs text-white/40">
              <div className="w-3 h-3 border-2 border-white/20 border-t-doma-blue rounded-full animate-spin" />
              <span>The Arcium MPC network is computing the winner privately…</span>
            </div>
          )}
          {closeError && (
            <div className="rounded-[14px] bg-red-900/20 border border-red-800/40 px-3 py-2.5 text-sm text-red-400">
              {closeError}
            </div>
          )}
        </div>
      )}

      {/* Computing state */}
      {isClosed && (
        <div className="bg-doma-card border border-doma-blue/20 rounded-2xl p-6 text-center space-y-3 backdrop-blur-md">
          <div className="w-10 h-10 mx-auto border-2 border-doma-blue/20 border-t-doma-blue rounded-full animate-spin" />
          <p className="text-white/60 text-sm">MPC network is computing the winner…</p>
          <p className="text-white/30 text-xs">This typically takes 15–30 seconds</p>
        </div>
      )}

      {/* Results */}
      {isFinalized && (
        <RevealPanel
          auctionPubkey={pubkey}
          creatorPubkey={auction.creator.toBase58()}
          winnerIdx={auction.winnerIdx as number | null}
          winningPrice={auction.winningPrice as BN | null}
          bidders={auction.bidders as PublicKey[]}
          settled={bidSettled}
          myBidRecord={
            alreadyBid && bidSlotIdx !== null
              ? { slotIdx: bidSlotIdx, settled: bidSettled, escrowWithdrawn }
              : null
          }
        />
      )}

      {/* Credit refund — losers only */}
      {isFinalized && publicKey && alreadyBid && !isWinner && (
        <div className="bg-doma-card border border-white/10 rounded-2xl p-5 space-y-3">
          <h3 className="text-white font-semibold text-sm">Participation Credit</h3>
          <p className="text-xs text-white/40">
            You didn&apos;t win this auction. Reclaim your locked participation credit.
          </p>
          <button
            onClick={async () => {
              if (creditRefunded) return;
              try {
                await refundCredit.mutateAsync(pubkey);
              } catch {
                // error handled below
              }
            }}
            disabled={refundCredit.isPending || creditRefunded}
            className={`w-full px-5 py-2.5 rounded-[14px] font-bold text-sm transition-colors ${
              creditRefunded
                ? "bg-emerald-900/20 border border-emerald-700/40 text-emerald-400 cursor-default"
                : "border border-doma-blue/40 text-doma-blue hover:bg-doma-blue/10 disabled:opacity-40 disabled:cursor-not-allowed"
            }`}
          >
            {refundCredit.isPending
              ? "Processing…"
              : creditRefunded
              ? "✓ Credit Reclaimed"
              : "🪙 Reclaim Credit"}
          </button>
          {refundCredit.isError && (
            <div className="rounded-[14px] bg-red-900/20 border border-red-800/40 px-3 py-2.5 text-sm text-red-400">
              {refundCredit.error instanceof Error ? refundCredit.error.message : String(refundCredit.error)}
            </div>
          )}
        </div>
      )}

      {/* Creator footer */}
      <div className="text-xs text-white/20 border-t border-white/5 pt-4 font-mono">
        Creator: {auction.creator.toBase58()}
      </div>
    </div>
  );
}
