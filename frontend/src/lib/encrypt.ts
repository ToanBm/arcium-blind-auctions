"use client";

import BN from "bn.js";
import {
  RescueCipher,
  x25519,
  deserializeLE,
  getMXEPublicKey,
} from "@arcium-hq/client";
import { randomBytes } from "@noble/hashes/utils";
import type * as anchor from "@coral-xyz/anchor";
import { PROGRAM_ID } from "./constants";

export interface EncryptedBid {
  ciphertext: number[];
  pubKey: number[];
  nonceBN: BN;
}

export async function encryptBid(
  provider: anchor.AnchorProvider,
  amount: bigint
): Promise<EncryptedBid> {
  const mxePubKeyRaw = await getMXEPublicKey(provider, PROGRAM_ID);
  if (!mxePubKeyRaw) throw new Error("Failed to fetch MXE public key");
  const privateKey = x25519.utils.randomSecretKey();
  const pubKey = x25519.getPublicKey(privateKey);
  const sharedSecret = x25519.getSharedSecret(privateKey, mxePubKeyRaw);
  const cipher = new RescueCipher(sharedSecret);
  const nonce = randomBytes(16);
  const [ct] = cipher.encrypt([amount], nonce);
  return {
    ciphertext: Array.from(ct) as number[],
    pubKey: Array.from(pubKey) as number[],
    nonceBN: new BN(deserializeLE(nonce).toString()),
  };
}
