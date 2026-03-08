"use client";

import { useMemo } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import * as anchor from "@coral-xyz/anchor";
import { PROGRAM_ID } from "./constants";
import type { BlindAuctions } from "../idl/blind_auctions";
import IDL from "../idl/blind_auctions.json";

export function useAnchorProgram() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  return useMemo(() => {
    if (!wallet) return null;
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
      skipPreflight: true,
    });
    const program = new anchor.Program<BlindAuctions>(
      IDL as anchor.Idl,
      provider
    );
    return { program, provider };
  }, [connection, wallet]);
}
