"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import CreateAuctionForm from "@/components/CreateAuctionForm";
import WalletButton from "@/components/WalletButton";

export default function CreatePage() {
  const { publicKey } = useWallet();

  if (!publicKey) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
        <span className="text-4xl">🔒</span>
        <p className="text-white/50 text-sm">Connect your wallet to create an auction.</p>
        <WalletButton />
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link
          href="/"
          className="text-white/30 hover:text-white transition-colors text-sm"
        >
          ← Back
        </Link>
      </div>

      <div className="bg-doma-card border border-white/10 rounded-[20px] px-6 py-5 backdrop-blur-xl">
        <div className="mb-5">
          <h1 className="text-lg font-semibold text-white">Create Auction</h1>
          <p className="text-xs text-white/40 mt-0.5">
            Bids are encrypted with x25519 + RescueCipher. Arcium MPC reveals the winner privately.
          </p>
        </div>
        <CreateAuctionForm />
      </div>
    </div>
  );
}
