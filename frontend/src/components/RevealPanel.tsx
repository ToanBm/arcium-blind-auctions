"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { useSettleAuction } from "@/hooks/useSettleAuction";
import { useWithdrawEscrow } from "@/hooks/useWithdrawEscrow";

interface Props {
  auctionPubkey: string;
  creatorPubkey: string;
  winnerIdx: number | null;
  winningPrice: BN | null;
  bidders: PublicKey[];
  settled: boolean;
  myBidRecord: { slotIdx: number; escrowWithdrawn: boolean; settled: boolean } | null;
}

export default function RevealPanel({
  auctionPubkey,
  creatorPubkey,
  winnerIdx,
  winningPrice,
  bidders,
  myBidRecord,
}: Props) {
  const { publicKey } = useWallet();
  const settle = useSettleAuction();
  const withdraw = useWithdrawEscrow();
  const [actionError, setActionError] = useState<string | null>(null);

  if (winnerIdx === null || winnerIdx === undefined || winningPrice === null) {
    return (
      <div className="bg-doma-card border border-white/10 rounded-2xl p-6 text-center text-white/40">
        No winner data yet.
      </div>
    );
  }

  const winnerKey = bidders[winnerIdx]?.toBase58() ?? "Unknown";
  const shortKey =
    winnerKey.length > 12
      ? winnerKey.slice(0, 8) + "…" + winnerKey.slice(-4)
      : winnerKey;
  const priceSol = (winningPrice.toNumber() / 1e9).toFixed(6);

  const isWinner = myBidRecord?.slotIdx === winnerIdx;
  const isLoser = myBidRecord !== null && !isWinner;
  const canSettle = isWinner && !myBidRecord?.settled;
  const canWithdraw = isLoser && !myBidRecord?.escrowWithdrawn;

  async function handleSettle() {
    setActionError(null);
    try {
      await settle.mutateAsync({ auctionPubkey, creatorPubkey, winnerPubkey: winnerKey });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleWithdraw() {
    setActionError(null);
    try {
      await withdraw.mutateAsync({ auctionPubkey });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="bg-doma-card border border-doma-blue/20 rounded-2xl p-6 space-y-4 shadow-glow-blue backdrop-blur-md">
      <div className="flex items-center gap-2">
        <span className="text-xl">🏆</span>
        <h3 className="text-white font-semibold text-lg">Auction Finalized</h3>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between py-2 border-b border-white/5">
          <span className="text-white/50 text-sm">Winner</span>
          <span className="font-mono text-white text-sm" title={winnerKey}>
            {shortKey}
            {isWinner && <span className="ml-2 text-doma-blue text-xs">(you)</span>}
          </span>
        </div>
        <div className="flex items-center justify-between py-2 border-b border-white/5">
          <span className="text-white/50 text-sm">Vickrey Price</span>
          <span className="text-doma-blue font-semibold">{priceSol} SOL</span>
        </div>
        <div className="flex items-center justify-between py-2">
          <span className="text-white/50 text-sm">Lamports</span>
          <span className="font-mono text-white/40 text-sm">
            {winningPrice.toString()}
          </span>
        </div>
      </div>

      {/* Settlement actions */}
      {publicKey && isWinner && (
        <div className="space-y-2 pt-2 border-t border-white/5">
          {!myBidRecord?.settled && (
            <p className="text-xs text-white/40">
              You won! Pay the Vickrey price to the creator and receive your bid refund.
            </p>
          )}
          <button
            onClick={handleSettle}
            disabled={settle.isPending || !!myBidRecord?.settled}
            className={`w-full px-5 py-2.5 rounded-[14px] font-bold text-sm transition-all ${
              myBidRecord?.settled
                ? "bg-emerald-900/20 border border-emerald-700/40 text-emerald-400 cursor-default"
                : "bg-doma-blue hover:bg-white text-doma-dark transform hover:scale-105 shadow-glow-blue disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none"
            }`}
          >
            {settle.isPending
              ? "Settling…"
              : myBidRecord?.settled
              ? "✓ Prize Claimed"
              : `Settle & Pay ${priceSol} SOL`}
          </button>
        </div>
      )}

      {publicKey && isLoser && (
        <div className="space-y-2 pt-2 border-t border-white/5">
          {!myBidRecord?.escrowWithdrawn && (
            <p className="text-xs text-white/40">
              You did not win. Reclaim your full SOL escrow deposit.
            </p>
          )}
          <button
            onClick={handleWithdraw}
            disabled={withdraw.isPending || !!myBidRecord?.escrowWithdrawn}
            className={`w-full px-5 py-2.5 rounded-[14px] font-bold text-sm transition-colors ${
              myBidRecord?.escrowWithdrawn
                ? "bg-emerald-900/20 border border-emerald-700/40 text-emerald-400 cursor-default"
                : "border border-doma-blue/40 text-doma-blue hover:bg-doma-blue/10 disabled:opacity-40 disabled:cursor-not-allowed"
            }`}
          >
            {withdraw.isPending
              ? "Withdrawing…"
              : myBidRecord?.escrowWithdrawn
              ? "✓ Escrow Withdrawn"
              : "Withdraw Escrow"}
          </button>
        </div>
      )}

      {actionError && (
        <div className="rounded-[14px] bg-red-900/20 border border-red-800/40 px-3 py-2.5 text-sm text-red-400">
          {actionError}
        </div>
      )}

      <p className="text-xs text-white/30">
        Second-price (Vickrey) auction — winner pays the second-highest bid.
        Computed privately by the Arcium MPC network.
      </p>
    </div>
  );
}
