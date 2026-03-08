import * as anchor from "@coral-xyz/anchor";
import { getArciumProgram, getCompDefAccAddress, getCompDefAccOffset } from "@arcium-hq/client";
import { PublicKey } from "@solana/web3.js";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;
const arciumProgram = getArciumProgram(provider);
const programId = new PublicKey("CFtpyNqYpEyQu8LjAm5DRT4yJvdREyUB2syinV3DPT5Q");

async function check(name: string) {
  const offset = Buffer.from(getCompDefAccOffset(name)).readUInt32LE();
  const pubkey = getCompDefAccAddress(programId, offset);
  console.log(`\n${name}`);
  console.log(`  addr: ${pubkey.toBase58()}`);
  const acc = await arciumProgram.account.computationDefinitionAccount.fetch(pubkey).catch(() => null);
  if (!acc) { console.log("  NOT FOUND"); return; }
  const src = acc.circuitSource as Record<string, unknown>;
  console.log("  circuitSource keys:", JSON.stringify(Object.keys(src)));
  const onChain = src["onChain"];
  console.log("  onChain:", JSON.stringify(onChain));
  if (Array.isArray(onChain) && onChain.length > 0) {
    console.log("  onChain[0] type:", typeof onChain[0]);
    console.log("  onChain[0] keys:", JSON.stringify(Object.keys(onChain[0] as object)));
    console.log("  isCompleted raw:", (onChain[0] as Record<string, unknown>).isCompleted);
    console.log("  isCompleted !!:", !!(onChain[0] as Record<string, unknown>).isCompleted);
    console.log("  isCompleted === true:", (onChain[0] as Record<string, unknown>).isCompleted === true);
  }
}

(async () => {
  await check("init_auction_state");
  await check("submit_bid");
  await check("reveal_winner");
})().catch(console.error);
