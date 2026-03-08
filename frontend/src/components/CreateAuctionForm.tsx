"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useCreateAuction } from "@/hooks/useCreateAuction";

export default function CreateAuctionForm() {
  const router = useRouter();
  const createAuction = useCreateAuction();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [durationSecs, setDurationSecs] = useState(24 * 3600);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (createAuction.isPending) {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [createAuction.isPending]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const endTime = Math.floor(Date.now() / 1000) + durationSecs;

    try {
      const result = await createAuction.mutateAsync({ title, description, endTime });
      router.push(`/auction/${result.auctionPda}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const titleLen = title.trim().length;
  const descLen = description.trim().length;
  const canSubmit = titleLen > 0 && titleLen <= 64 && descLen > 0 && !createAuction.isPending;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className="block text-sm font-medium text-white/80 mb-1.5">
          Title <span className="text-white/30 font-normal">({titleLen}/64)</span>
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Rare NFT: Genesis Block #1"
          maxLength={64}
          required
          className="w-full bg-white/5 border border-white/10 rounded-[14px] px-3 py-2.5 text-white placeholder-white/25 text-sm focus:outline-none focus:border-doma-blue/50 focus:ring-1 focus:ring-doma-blue/20 transition-colors"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-white/80 mb-1.5">
          Description <span className="text-white/30 font-normal">({descLen}/256)</span>
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe what you're auctioning…"
          rows={3}
          maxLength={256}
          required
          className="w-full bg-white/5 border border-white/10 rounded-[14px] px-3 py-2.5 text-white placeholder-white/25 text-sm focus:outline-none focus:border-doma-blue/50 focus:ring-1 focus:ring-doma-blue/20 transition-colors resize-none"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-white/80 mb-1.5">
          Auction duration
        </label>
        <div className="flex items-center gap-2">
          {[
            { label: "5m", secs: 5 * 60 },
            { label: "1h", secs: 1 * 3600 },
            { label: "6h", secs: 6 * 3600 },
            { label: "1d", secs: 24 * 3600 },
            { label: "3d", secs: 72 * 3600 },
            { label: "7d", secs: 168 * 3600 },
          ].map(({ label, secs }) => (
            <button
              key={secs}
              type="button"
              onClick={() => setDurationSecs(secs)}
              className={`flex-1 py-2 rounded-[14px] text-sm font-medium border transition-all ${
                durationSecs === secs
                  ? "bg-doma-blue border-doma-blue text-doma-dark font-bold"
                  : "bg-white/5 border-white/10 text-white/50 hover:border-doma-blue/30 hover:text-white"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full px-5 py-2.5 rounded-[14px] bg-doma-blue hover:bg-white text-doma-dark font-bold text-sm transition-all transform hover:scale-105 shadow-glow-blue disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none"
      >
        {createAuction.isPending ? "Initializing encrypted state…" : "Create Auction"}
      </button>

      {createAuction.isPending && (
        <div className="flex items-center gap-3 justify-center py-2">
          <div className="w-4 h-4 border-2 border-white/20 border-t-doma-blue rounded-full animate-spin flex-shrink-0" />
          <div className="text-xs text-white/50 text-center">
            <p>{elapsed < 5 ? "Creating auction on-chain…" : "Waiting for Arcium MPC to initialize encrypted state…"}</p>
            <p className="text-white/25 mt-0.5">
              {elapsed}s elapsed{elapsed >= 10 ? " — MPC network can take 1–3 min on devnet" : ""}
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-[14px] bg-red-900/20 border border-red-800/40 px-3 py-2.5 text-sm text-red-400">
          {error}
        </div>
      )}
    </form>
  );
}
