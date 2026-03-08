"use client";

import { useState, useEffect, useRef } from "react";
import { useCastBid } from "@/hooks/useCastBid";
import { useCredits } from "@/hooks/useCredits";
import { useClaimCredits } from "@/hooks/useClaimCredits";

interface Props {
  auctionPubkey: string;
  disabled?: boolean;
  disabledReason?: string;
}

export default function BidForm({ auctionPubkey, disabled, disabledReason }: Props) {
  const [amountSol, setAmountSol] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const castBid = useCastBid();
  const { data: credits, isLoading: creditsLoading } = useCredits();
  const claimCredits = useClaimCredits();
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (castBid.isPending) {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [castBid.isPending]);

  const hasCredits = credits !== null && credits !== undefined && credits.balance >= 1;
  const noCredits = !creditsLoading && credits !== null && credits !== undefined && credits.balance < 1;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!amountSol) return;

    const ceiling = BigInt(Math.round(parseFloat(amountSol) * 1e9));
    if (ceiling <= 0n) return;

    setError(null);
    setSuccess(false);
    try {
      await castBid.mutateAsync({ auctionPubkey, ceiling });
      setSuccess(true);
      setAmountSol("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="bg-doma-card border border-white/10 rounded-2xl p-5 space-y-4 backdrop-blur-md">
      <h3 className="text-white font-semibold">Place Encrypted Bid</h3>
      <p className="text-xs text-white/40">Your bid amount is encrypted before submission — other bidders cannot see it.</p>

      {disabled ? (
        <div className="rounded-[14px] bg-yellow-900/20 border border-yellow-800/40 px-3 py-2.5 text-sm text-yellow-400">
          {disabledReason ?? "Bidding is disabled."}
        </div>
      ) : noCredits ? (
        <div className="space-y-3">
          <div className="rounded-[14px] bg-doma-blue/5 border border-doma-blue/20 px-3 py-2.5 text-sm text-doma-blue/80">
            You need credits to place a bid. Credits are free — claim some to get started.
          </div>
          <button
            onClick={() => claimCredits.mutate(3)}
            disabled={claimCredits.isPending}
            className="w-full px-5 py-2.5 rounded-[14px] border border-doma-blue/40 text-doma-blue font-bold text-sm hover:bg-doma-blue/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {claimCredits.isPending ? "Claiming…" : "🪙 Claim 3 Credits"}
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-white/80 mb-1.5">
              Bid Amount (SOL)
            </label>
            <input
              type="number"
              step="0.000000001"
              min="0.000000001"
              value={amountSol}
              onChange={(e) => setAmountSol(e.target.value)}
              placeholder="e.g. 0.5"
              disabled={castBid.isPending}
              className="w-full bg-white/5 border border-white/10 rounded-[14px] px-3 py-2.5 text-white placeholder-white/25 text-sm focus:outline-none focus:border-doma-blue/50 focus:ring-1 focus:ring-doma-blue/20 transition-colors"
            />
          </div>
          {hasCredits && (
            <p className="text-xs text-white/30">
              🪙 {credits!.balance} credit{credits!.balance !== 1 ? "s" : ""} available — placing a bid locks 1 credit. Losers can reclaim it after the auction.
            </p>
          )}
          <button
            type="submit"
            disabled={castBid.isPending || !amountSol}
            className="w-full px-5 py-2.5 rounded-[14px] bg-doma-blue hover:bg-white text-doma-dark font-bold text-sm transition-all transform hover:scale-105 shadow-glow-blue disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none"
          >
            {castBid.isPending ? "Encrypting & submitting…" : "Submit Encrypted Bid"}
          </button>
        </form>
      )}

      {castBid.isPending && (
        <div className="flex items-center gap-2 text-xs text-white/40">
          <div className="w-3 h-3 border-2 border-white/20 border-t-doma-blue rounded-full animate-spin flex-shrink-0" />
          <span>
            {elapsed < 5 ? "Encrypting & submitting bid…" : `MPC computation in progress… ${elapsed}s${elapsed >= 10 ? " (1–3 min on devnet)" : ""}`}
          </span>
        </div>
      )}

      {success && (
        <div className="rounded-[14px] bg-emerald-900/20 border border-emerald-700/40 px-3 py-2.5 text-sm text-emerald-400">
          Bid registered! MPC computation finalized.
        </div>
      )}

      {error && (
        <div className="rounded-[14px] bg-red-900/20 border border-red-800/40 px-3 py-2.5 text-sm text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}
