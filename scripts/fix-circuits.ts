/**
 * fix-circuits.ts
 *
 * Robustly uploads and finalizes all three blind-auction circuits, handling
 * partial-upload state and 429 rate-limit retries.
 *
 * Run:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn ts-node scripts/fix-circuits.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import {
  getArciumProgram,
  getMXEAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getLookupTableAddress,
} from "@arcium-hq/client";
import { BlindAuctions } from "../target/types/blind_auctions";
import idl from "../target/idl/blind_auctions.json";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;
const program = new anchor.Program(idl as anchor.Idl, provider) as unknown as anchor.Program<BlindAuctions>;
const arciumProgram = getArciumProgram(provider);

const MXE_PROGRAM_ID = new PublicKey("CFtpyNqYpEyQu8LjAm5DRT4yJvdREyUB2syinV3DPT5Q");
const MAX_REALLOC_PER_IX = 10240;
const MAX_UPLOAD_PER_TX_BYTES = 814;

function compDefOffsetNum(name: string): number {
  return Buffer.from(getCompDefAccOffset(name)).readUInt32LE();
}

function getRawCircuitPda(compDefPubkey: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ComputationDefinitionRaw"), compDefPubkey.toBuffer(), Buffer.from([0])],
    arciumProgram.programId
  );
  return pda;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendTxWithRetry(tx: Transaction, maxRetries = 5): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const blockInfo = await provider.connection.getLatestBlockhash({ commitment: "confirmed" });
      tx.recentBlockhash = blockInfo.blockhash;
      tx.lastValidBlockHeight = blockInfo.lastValidBlockHeight;
      tx.feePayer = provider.wallet.publicKey;
      const signed = await provider.wallet.signTransaction(tx);
      const sig = await provider.connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      await provider.connection.confirmTransaction(
        { signature: sig, blockhash: blockInfo.blockhash, lastValidBlockHeight: blockInfo.lastValidBlockHeight },
        "confirmed"
      );
      return sig;
    } catch (e: unknown) {
      const msg = (e as { message?: string })?.message ?? String(e);
      if (attempt < maxRetries - 1 && (msg.includes("Blockhash") || msg.includes("429"))) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw new Error("sendTxWithRetry exhausted");
}

// Max instructions per resize tx — keep well under the 1232-byte tx size limit.
const MAX_RESIZE_IXS_PER_TX = 12;

async function resizeRawCircuitAcc(
  offset: number,
  currentBytes: number,
  requiredBytes: number
) {
  const delta = requiredBytes - currentBytes;
  if (delta <= 0) { console.log("  Account already big enough"); return; }
  const totalIxs = Math.ceil(delta / MAX_REALLOC_PER_IX);
  const txCount = Math.ceil(totalIxs / MAX_RESIZE_IXS_PER_TX);
  console.log(`  Resizing: ${currentBytes} → ${requiredBytes} bytes (${totalIxs} realloc IXs across ${txCount} txs)`);

  const ix = await arciumProgram.methods
    .embiggenRawCircuitAcc(offset, MXE_PROGRAM_ID, 0)
    .accounts({ signer: provider.wallet.publicKey })
    .instruction();

  let remaining = totalIxs;
  let batch = 0;
  while (remaining > 0) {
    const batchSize = Math.min(remaining, MAX_RESIZE_IXS_PER_TX);
    const tx = new Transaction();
    for (let i = 0; i < batchSize; i++) tx.add(ix);
    await sendTxWithRetry(tx);
    remaining -= batchSize;
    batch++;
    if (batch % 5 === 0) console.log(`    Resize progress: ${totalIxs - remaining}/${totalIxs}`);
    await sleep(300);
  }
  console.log("  ✓ Resize complete");
}

async function uploadWithRetry(offset: number, byteOffset: number, padded: Buffer, maxRetries = 12): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (arciumProgram.methods as any)
        .uploadCircuit(offset, MXE_PROGRAM_ID, 0, Array.from(padded), byteOffset)
        .accounts({ signer: provider.wallet.publicKey })
        .rpc({ commitment: "confirmed", skipPreflight: false });
      return;
    } catch (e: unknown) {
      const msg: string = (e as { transactionMessage?: string; message?: string })?.transactionMessage
        ?? (e as { message?: string })?.message ?? String(e);
      if (msg.includes("429") || msg.includes("Too Many") || msg.includes("Blockhash")) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`uploadCircuit failed after ${maxRetries} retries at offset ${byteOffset}`);
}

async function uploadMissingChunks(name: string, offset: number, rawCircuit: Buffer) {
  const compDefPubkey = getCompDefAccAddress(MXE_PROGRAM_ID, offset);
  const rawCircuitPda = getRawCircuitPda(compDefPubkey);
  const onChainAcc = await provider.connection.getAccountInfo(rawCircuitPda);
  if (!onChainAcc) throw new Error(`Raw circuit account not found for ${name}`);

  const onChainData = onChainAcc.data.subarray(9); // skip 8-byte discriminator + 1-byte bump
  const totalTxs = Math.ceil(rawCircuit.length / MAX_UPLOAD_PER_TX_BYTES);
  const missing: number[] = [];
  for (let i = 0; i < totalTxs; i++) {
    const start = i * MAX_UPLOAD_PER_TX_BYTES;
    const end = Math.min(start + MAX_UPLOAD_PER_TX_BYTES, rawCircuit.length);
    if (!rawCircuit.subarray(start, end).equals(onChainData.subarray(start, end))) {
      missing.push(i);
    }
  }
  console.log(`  Missing ${missing.length}/${totalTxs} chunks — uploading...`);

  let uploaded = 0;
  for (const idx of missing) {
    const byteOffset = idx * MAX_UPLOAD_PER_TX_BYTES;
    const chunk = rawCircuit.subarray(byteOffset, byteOffset + MAX_UPLOAD_PER_TX_BYTES);
    const padded = Buffer.alloc(MAX_UPLOAD_PER_TX_BYTES);
    chunk.copy(padded);
    await uploadWithRetry(offset, byteOffset, padded);
    uploaded++;
    if (uploaded % 20 === 0) console.log(`    Progress: ${uploaded}/${missing.length}`);
    // Small throttle to reduce 429s
    await sleep(200);
  }
  console.log(`  ✓ Uploaded ${uploaded} chunks`);
}

async function finalizeCircuit(offset: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx = await (arciumProgram.methods as any)
    .finalizeComputationDefinition(offset, MXE_PROGRAM_ID)
    .accounts({ signer: provider.wallet.publicKey })
    .transaction();
  await sendTxWithRetry(tx);
  console.log("  ✓ Finalized");
}

async function fixCircuit(
  name: string,
  initMethodName: "initAuctionStateCompDef" | "initSubmitBidCompDef" | "initRevealWinnerCompDef"
) {
  console.log(`\n=== ${name} ===`);
  const offset = compDefOffsetNum(name);
  const compDefPubkey = getCompDefAccAddress(MXE_PROGRAM_ID, offset);
  const rawCircuit = fs.readFileSync(`build/${name}.arcis`);

  // Check if already finalized
  const compDefAcc = await arciumProgram.account.computationDefinitionAccount
    .fetch(compDefPubkey).catch(() => null);
  if (compDefAcc) {
    const src = compDefAcc.circuitSource as Record<string, unknown>;
    const onChain = src["onChain"] as Record<string | number, { isCompleted?: unknown }> | undefined;
    const first = onChain && (Array.isArray(onChain) ? onChain[0] : Object.values(onChain)[0]);
    if ("onChain" in src && first?.isCompleted) {
      console.log("  Already finalized — skipping");
      return;
    }
  }

  // Init comp def if missing
  if (!compDefAcc) {
    console.log("  Initializing comp def...");
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(getMXEAccAddress(MXE_PROGRAM_ID));
    const lutAddress = getLookupTableAddress(MXE_PROGRAM_ID, mxeAcc.lutOffsetSlot);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (program.methods as any)[initMethodName]()
      .accounts({
        payer: provider.wallet.publicKey,
        mxeAccount: getMXEAccAddress(MXE_PROGRAM_ID),
        compDefAccount: compDefPubkey,
        addressLookupTable: lutAddress,
      })
      .rpc({ commitment: "confirmed", skipPreflight: true });
    console.log("  ✓ Comp def initialized");
  } else {
    console.log("  Comp def exists (partial upload)");
  }

  // Check/init raw circuit account
  const rawCircuitPda = getRawCircuitPda(compDefPubkey);
  let onChainAcc = await provider.connection.getAccountInfo(rawCircuitPda);
  if (!onChainAcc) {
    console.log("  Initializing raw circuit acc...");
    await arciumProgram.methods
      .initRawCircuitAcc(offset, MXE_PROGRAM_ID, 0)
      .accounts({ signer: provider.wallet.publicKey })
      .rpc({ commitment: "confirmed", skipPreflight: true });
    onChainAcc = await provider.connection.getAccountInfo(rawCircuitPda);
    console.log("  ✓ Raw circuit acc initialized");
  }

  const currentBytes = onChainAcc!.data.length;
  const requiredBytes = rawCircuit.length + 9;
  await resizeRawCircuitAcc(offset, currentBytes, requiredBytes);

  await uploadMissingChunks(name, offset, rawCircuit);
  await finalizeCircuit(offset);
}

async function main() {
  console.log(`Program: ${MXE_PROGRAM_ID.toBase58()}`);
  console.log(`Payer:   ${provider.wallet.publicKey.toBase58()}`);

  await fixCircuit("init_auction_state", "initAuctionStateCompDef");
  await fixCircuit("submit_bid", "initSubmitBidCompDef");
  await fixCircuit("reveal_winner", "initRevealWinnerCompDef");

  console.log("\n✓ All circuits finalized!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
