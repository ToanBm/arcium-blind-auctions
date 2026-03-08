import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { getCompDefAccOffset } from "@arcium-hq/client";

export function getAuctionPda(
  creator: PublicKey,
  nonce: BN,
  programId: PublicKey
): [PublicKey, number] {
  const nonceBytes = nonce.toArrayLike(Buffer, 'le', 8);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("auction"), creator.toBuffer(), nonceBytes],
    programId
  );
}

export function getBidRecordPda(
  bidder: PublicKey,
  auction: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bid_record"), bidder.toBuffer(), auction.toBuffer()],
    programId
  );
}

export function getCreditAccountPda(
  owner: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("credit_account"), owner.toBuffer()],
    programId
  );
}

export function getBidVaultPda(
  bidder: PublicKey,
  auction: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bid_vault"), bidder.toBuffer(), auction.toBuffer()],
    programId
  );
}

export function compDefOffsetNum(name: string): number {
  return Buffer.from(getCompDefAccOffset(name)).readUInt32LE();
}
