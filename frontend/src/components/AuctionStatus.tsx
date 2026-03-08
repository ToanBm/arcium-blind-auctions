"use client";

import { useEffect, useState } from "react";
import BN from "bn.js";

interface Props {
  status: Record<string, unknown>;
  endTime: BN;
}

function getStatusStyle(
  status: Record<string, unknown>,
  endTimeSec: number
): {
  label: string;
  className: string;
  dot: string;
} {
  if ("initializing" in status)
    return {
      label: "Initializing MPC…",
      className: "bg-yellow-900/30 text-yellow-400 border-yellow-700/40",
      dot: "bg-yellow-400 animate-pulse",
    };
  if ("active" in status) {
    const isPast = Date.now() / 1000 > endTimeSec;
    if (isPast)
      return {
        label: "Ended",
        className: "bg-white/5 text-white/50 border-white/10",
        dot: "bg-white/30",
      };
    return {
      label: "Active",
      className: "bg-emerald-900/30 text-emerald-400 border-emerald-700/40",
      dot: "bg-emerald-400",
    };
  }
  if ("closed" in status)
    return {
      label: "MPC Computing…",
      className: "bg-doma-blue/10 text-doma-blue border-doma-blue/30",
      dot: "bg-doma-blue animate-pulse",
    };
  if ("finalized" in status)
    return {
      label: "Finalized",
      className: "bg-purple-900/30 text-purple-400 border-purple-700/40",
      dot: "bg-purple-400",
    };
  return {
    label: "Unknown",
    className: "bg-white/5 text-white/40 border-white/10",
    dot: "bg-white/40",
  };
}

function useCountdown(endTimeSec: number) {
  const [remaining, setRemaining] = useState(
    endTimeSec - Math.floor(Date.now() / 1000)
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setRemaining(endTimeSec - Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [endTimeSec]);

  return remaining;
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "Ended";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function AuctionStatus({ status, endTime }: Props) {
  const endTimeSec = endTime.toNumber();
  const { label, className, dot } = getStatusStyle(status, endTimeSec);
  const remaining = useCountdown(endTimeSec);

  return (
    <div className="flex flex-col items-end gap-1 shrink-0">
      <span
        className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-medium border rounded-full ${className}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
        {label}
      </span>
      {"active" in status && remaining > 0 && (
        <span className="text-xs text-white/30 tabular-nums font-mono">
          {formatCountdown(remaining)}
        </span>
      )}
    </div>
  );
}
