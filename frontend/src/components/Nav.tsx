"use client";

import Link from "next/link";
import WalletButton from "@/components/WalletButton";
import { useWallet } from "@solana/wallet-adapter-react";
import { useCredits } from "@/hooks/useCredits";
import { useClaimCredits } from "@/hooks/useClaimCredits";

export default function Nav() {
  const { publicKey } = useWallet();
  const { data: credits } = useCredits();
  const claimCredits = useClaimCredits();

  return (
    <header className="sticky top-0 z-40 px-4 sm:px-6 pt-3">
      <div className="w-4/5 mx-auto bg-doma-card border border-white/10 rounded-[20px] px-6 py-3 backdrop-blur-xl flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-3">
          <span className="text-xl leading-none">🔒</span>
          <div>
            <h1 className="text-sm font-logo font-extrabold text-white leading-none tracking-wide">
              Blind Auctions
            </h1>
            <p className="text-xs text-white/40 leading-none mt-0.5">Powered by Arcium MPC</p>
          </div>
        </Link>
        <div className="flex items-center gap-3">
          {publicKey && credits !== null && credits !== undefined && (
            credits.balance >= 1 ? (
              <span className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-[10px] bg-doma-blue/10 border border-doma-blue/30 text-doma-blue text-xs font-medium">
                🪙 {credits.balance} credit{credits.balance !== 1 ? "s" : ""}
              </span>
            ) : (
              <button
                onClick={() => claimCredits.mutate(3)}
                disabled={claimCredits.isPending}
                className="hidden sm:flex items-center gap-1 px-3 py-1.5 rounded-[10px] border border-doma-blue/30 text-doma-blue text-xs font-medium hover:bg-doma-blue/10 transition-colors disabled:opacity-50"
              >
                {claimCredits.isPending ? "Claiming…" : "+ Claim Credits"}
              </button>
            )
          )}
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
