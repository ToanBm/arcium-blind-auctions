/**
 * Blind Auctions — Integration Tests
 *
 * Tests the full lifecycle of a Vickrey (second-price) blind auction:
 *   1. Initialize computation definitions (once per deployment)
 *   2. Create an auction with a deadline
 *   3. Seed the encrypted state via MPC (`init_auction_mpc`)
 *   4. Submit encrypted bids from multiple bidders
 *   5. Close the auction + reveal winner and Vickrey price via MPC
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  RescueCipher,
  getArciumEnv,
  x25519,
  deserializeLE,
  awaitComputationFinalization,
  getMXEPublicKey,
  getComputationAccAddress,
  getClusterAccAddress,
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getLookupTableAddress,
  getArciumProgram,
  uploadCircuit,
} from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as fs from "fs";
import { expect } from "chai";
import { BlindAuctions } from "../target/types/blind_auctions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compDefOffsetNum(name: string): number {
  return Buffer.from(getCompDefAccOffset(name)).readUInt32LE();
}

function getAuctionPda(
  creator: PublicKey,
  nonce: BN,
  programId: PublicKey
): [PublicKey, number] {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(BigInt(nonce.toString()));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("auction"), creator.toBuffer(), nonceBytes],
    programId
  );
}

function getBidRecordPda(
  bidder: PublicKey,
  auction: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bid_record"), bidder.toBuffer(), auction.toBuffer()],
    programId
  );
}

async function waitForAuctionStatus(
  pda: PublicKey,
  prog: Program<BlindAuctions>,
  expectedKey: string,
  timeoutMs = 120_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const a = await prog.account.auction.fetch(pda);
    if (expectedKey in (a.status as object)) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const a = await prog.account.auction.fetch(pda);
  throw new Error(
    `Auction status timeout. Got: ${JSON.stringify(a.status)}, expected: ${expectedKey}`
  );
}

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries = 20,
  retryDelayMs = 500
): Promise<Uint8Array> {
  let lastError: unknown;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const key = await getMXEPublicKey(provider, programId);
      if (key) return key;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw lastError ?? new Error("getMXEPublicKey failed after retries");
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("blind-auctions", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.BlindAuctions as Program<BlindAuctions>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const arciumProgram = getArciumProgram(provider);
  const arciumEnv = getArciumEnv();

  // Participants
  const auctioneer = Keypair.generate();
  const bidderA = Keypair.generate();
  const bidderB = Keypair.generate();
  const bidderC = Keypair.generate();

  const AUCTION_DURATION_SECS = 5 * 60; // 5 minutes — long enough for all bids to land before deadline

  const AUCTION_TITLE = "Rare NFT: Genesis Block #1";
  const AUCTION_DESC =
    "One-of-a-kind digital artwork commemorating the first Solana mainnet block.";

  let auctionPda: PublicKey;
  const auctionNonce = new BN(randomBytes(8), "hex");

  // Helper: check whether a comp def is already finalized on-chain.
  async function isCompDefFinalized(name: string): Promise<boolean> {
    const pubkey = getCompDefAccAddress(
      program.programId,
      compDefOffsetNum(name)
    );
    const acc = await arciumProgram.account.computationDefinitionAccount
      .fetch(pubkey)
      .catch(() => null);
    if (!acc) return false;
    const src = acc.circuitSource as Record<string, unknown>;
    if (!("onChain" in src)) return false;
    const onChain = src["onChain"] as Record<string | number, { isCompleted?: unknown }>;
    const first = Array.isArray(onChain) ? onChain[0] : Object.values(onChain)[0];
    return !!first?.isCompleted;
  }

  // Helper: fetch LUT address for comp def init calls.
  async function getLutAddress(): Promise<PublicKey> {
    const mxeAccount = getMXEAccAddress(program.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    return getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);
  }

  before(async () => {
    // Fund all test wallets from the provider wallet.
    const connection = provider.connection;
    const transferTx = new Transaction();
    for (const kp of [auctioneer, bidderA, bidderB, bidderC]) {
      transferTx.add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: kp.publicKey,
          lamports: 0.5 * anchor.web3.LAMPORTS_PER_SOL,
        })
      );
    }
    const blockInfo = await connection.getLatestBlockhash("confirmed");
    transferTx.recentBlockhash = blockInfo.blockhash;
    transferTx.lastValidBlockHeight = blockInfo.lastValidBlockHeight;
    transferTx.feePayer = provider.wallet.publicKey;
    const signed = await provider.wallet.signTransaction(transferTx);
    const sig = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: true,
    });
    const result = await connection.confirmTransaction(
      { signature: sig, ...blockInfo },
      "confirmed"
    );
    if (result.value.err) {
      throw new Error(`Fund transfer failed: ${JSON.stringify(result.value.err)}`);
    }

    [auctionPda] = getAuctionPda(
      auctioneer.publicKey,
      auctionNonce,
      program.programId
    );
  });

  // -------------------------------------------------------------------------
  // Step 1: Initialize computation definitions + upload circuits
  // -------------------------------------------------------------------------

  it("initializes init_auction_state computation definition", async () => {
    if (await isCompDefFinalized("init_auction_state")) {
      console.log("    init_auction_state already finalized — skipping");
      return;
    }
    const lutAddress = await getLutAddress();
    await program.methods
      .initAuctionStateCompDef()
      .accounts({
        payer: provider.wallet.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          compDefOffsetNum("init_auction_state")
        ),
        addressLookupTable: lutAddress,
      })
      .rpc({ commitment: "confirmed", skipPreflight: true });
    const rawCircuit = fs.readFileSync("build/init_auction_state.arcis");
    await uploadCircuit(
      provider,
      "init_auction_state",
      program.programId,
      rawCircuit,
      true,
      5,
      { skipPreflight: true, commitment: "confirmed" }
    );
  });

  it("initializes submit_bid computation definition", async () => {
    if (await isCompDefFinalized("submit_bid")) {
      console.log("    submit_bid already finalized — skipping");
      return;
    }
    const lutAddress = await getLutAddress();
    await program.methods
      .initSubmitBidCompDef()
      .accounts({
        payer: provider.wallet.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          compDefOffsetNum("submit_bid")
        ),
        addressLookupTable: lutAddress,
      })
      .rpc({ commitment: "confirmed", skipPreflight: true });
    const rawCircuit = fs.readFileSync("build/submit_bid.arcis");
    await uploadCircuit(
      provider,
      "submit_bid",
      program.programId,
      rawCircuit,
      true,
      5,
      { skipPreflight: true, commitment: "confirmed" }
    );
  });

  it("initializes reveal_winner computation definition", async () => {
    if (await isCompDefFinalized("reveal_winner")) {
      console.log("    reveal_winner already finalized — skipping");
      return;
    }
    const lutAddress = await getLutAddress();
    await program.methods
      .initRevealWinnerCompDef()
      .accounts({
        payer: provider.wallet.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          compDefOffsetNum("reveal_winner")
        ),
        addressLookupTable: lutAddress,
      })
      .rpc({ commitment: "confirmed", skipPreflight: true });
    const rawCircuit = fs.readFileSync("build/reveal_winner.arcis");
    await uploadCircuit(
      provider,
      "reveal_winner",
      program.programId,
      rawCircuit,
      true,
      5,
      { skipPreflight: true, commitment: "confirmed" }
    );
  });

  // -------------------------------------------------------------------------
  // Step 2: Create auction
  // -------------------------------------------------------------------------

  it("creates an auction", async () => {
    const endTime = new BN(Math.floor(Date.now() / 1000) + AUCTION_DURATION_SECS);

    await program.methods
      .createAuction(auctionNonce, AUCTION_TITLE, AUCTION_DESC, endTime)
      .accountsPartial({
        creator: auctioneer.publicKey,
        auction: auctionPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([auctioneer])
      .rpc({ commitment: "confirmed", skipPreflight: true });

    const auction = await program.account.auction.fetch(auctionPda);
    expect(auction.title).to.equal(AUCTION_TITLE);
    expect(auction.bidCount).to.equal(0);
    expect(auction.status).to.deep.equal({ initializing: {} });
  });

  // -------------------------------------------------------------------------
  // Step 3: Initialize encrypted state via MPC
  // -------------------------------------------------------------------------

  it("seeds encrypted auction state to zero via MPC", async () => {
    const computationOffset = new BN(randomBytes(8), "hex");

    await program.methods
      .initAuctionMpc(computationOffset)
      .accountsPartial({
        payer: auctioneer.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        computationAccount: getComputationAccAddress(
          arciumEnv.arciumClusterOffset,
          computationOffset
        ),
        clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          compDefOffsetNum("init_auction_state")
        ),
        auction: auctionPda,
      })
      .signers([auctioneer])
      .rpc({ commitment: "confirmed", skipPreflight: true });

    await awaitComputationFinalization(
      provider,
      computationOffset,
      program.programId,
      "confirmed"
    );

    await waitForAuctionStatus(auctionPda, program, "active", 300_000);
    const auction = await program.account.auction.fetch(auctionPda);
    expect(auction.status).to.deep.equal({ active: {} });
  });

  // -------------------------------------------------------------------------
  // Step 4: Submit encrypted bids
  // -------------------------------------------------------------------------

  /**
   * Encrypt a u64 bid amount with the bidder's ephemeral x25519 key.
   */
  async function encryptBid(amount: number): Promise<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ciphertext: any;
    pubKey: Uint8Array;
    nonceBN: BN;
  }> {
    const mxePubKey = await getMXEPublicKeyWithRetry(
      provider,
      program.programId
    );
    const privateKey = x25519.utils.randomSecretKey();
    const pubKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePubKey);
    const cipher = new RescueCipher(sharedSecret);
    const nonce = randomBytes(16);
    const [ct] = cipher.encrypt([BigInt(amount)], nonce);
    return {
      ciphertext: ct,
      pubKey,
      nonceBN: new BN(deserializeLE(nonce).toString()),
    };
  }

  async function submitBid(bidder: Keypair, amount: number): Promise<void> {
    const { ciphertext, pubKey, nonceBN } = await encryptBid(amount);
    const computationOffset = new BN(randomBytes(8), "hex");
    const [bidRecordPda] = getBidRecordPda(
      bidder.publicKey,
      auctionPda,
      program.programId
    );

    await program.methods
      .castBid(
        computationOffset,
        Array.from(ciphertext) as number[],
        Array.from(pubKey) as number[],
        nonceBN
      )
      .accountsPartial({
        payer: bidder.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        computationAccount: getComputationAccAddress(
          arciumEnv.arciumClusterOffset,
          computationOffset
        ),
        clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          compDefOffsetNum("submit_bid")
        ),
        auction: auctionPda,
        bidRecord: bidRecordPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([bidder])
      .rpc({ commitment: "confirmed", skipPreflight: true });

    await awaitComputationFinalization(
      provider,
      computationOffset,
      program.programId,
      "confirmed"
    );
  }

  it("bidderA bids 300 credits", async () => {
    await submitBid(bidderA, 300);
    const auction = await program.account.auction.fetch(auctionPda);
    expect(auction.bidCount).to.equal(1);
  });

  it("bidderB bids 500 credits (highest)", async () => {
    await submitBid(bidderB, 500);
    const auction = await program.account.auction.fetch(auctionPda);
    expect(auction.bidCount).to.equal(2);
  });

  it("bidderC bids 200 credits (lowest)", async () => {
    await submitBid(bidderC, 200);
    const auction = await program.account.auction.fetch(auctionPda);
    expect(auction.bidCount).to.equal(3);
  });

  it("rejects double bidding from bidderA", async () => {
    try {
      await submitBid(bidderA, 999);
      expect.fail("Should have rejected double bid");
    } catch (e: unknown) {
      expect(e).to.be.instanceOf(Error);
    }
  });

  // -------------------------------------------------------------------------
  // Step 5: Close auction + reveal winner
  //
  // We create a *second* auction with an already-expired end_time to test
  // the close+reveal path without waiting for the real deadline.
  // -------------------------------------------------------------------------

  it("reveals winner and Vickrey price for a fresh closable auction", async () => {
    const closableNonce = new BN(randomBytes(8), "hex");
    const [closablePda] = getAuctionPda(
      auctioneer.publicKey,
      closableNonce,
      program.programId
    );

    // 20-second deadline — enough for two bid computations (~6 s each) to land
    // before it expires, then we sleep until after the deadline to close.
    const auctionEndTime = Math.floor(Date.now() / 1000) + 20;
    const pastEndTime = new BN(auctionEndTime);
    await program.methods
      .createAuction(closableNonce, "Closable", "short test auction", pastEndTime)
      .accountsPartial({
        creator: auctioneer.publicKey,
        auction: closablePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([auctioneer])
      .rpc({ commitment: "confirmed", skipPreflight: true });

    // Seed MPC state.
    const initOffset = new BN(randomBytes(8), "hex");
    await program.methods
      .initAuctionMpc(initOffset)
      .accountsPartial({
        payer: auctioneer.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        computationAccount: getComputationAccAddress(
          arciumEnv.arciumClusterOffset,
          initOffset
        ),
        clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          compDefOffsetNum("init_auction_state")
        ),
        auction: closablePda,
      })
      .signers([auctioneer])
      .rpc({ commitment: "confirmed", skipPreflight: true });
    await awaitComputationFinalization(
      provider,
      initOffset,
      program.programId,
      "confirmed"
    );
    await waitForAuctionStatus(closablePda, program, "active", 120_000);

    // Place two bids: bidderA=100, bidderB=200.
    // Expected Vickrey result: bidderB wins, pays 100 (second-highest).
    async function submitBidToAuction(
      bidder: Keypair,
      amount: number,
      auctionKey: PublicKey
    ): Promise<void> {
      const { ciphertext, pubKey, nonceBN } = await encryptBid(amount);
      const compOff = new BN(randomBytes(8), "hex");
      const [bidRec] = getBidRecordPda(
        bidder.publicKey,
        auctionKey,
        program.programId
      );
      await program.methods
        .castBid(
          compOff,
          Array.from(ciphertext) as number[],
          Array.from(pubKey) as number[],
          nonceBN
        )
        .accountsPartial({
          payer: bidder.publicKey,
          mxeAccount: getMXEAccAddress(program.programId),
          computationAccount: getComputationAccAddress(
            arciumEnv.arciumClusterOffset,
            compOff
          ),
          clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
          mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
          executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            compDefOffsetNum("submit_bid")
          ),
          auction: auctionKey,
          bidRecord: bidRec,
          systemProgram: SystemProgram.programId,
        })
        .signers([bidder])
        .rpc({ commitment: "confirmed", skipPreflight: true });
      await awaitComputationFinalization(
        provider,
        compOff,
        program.programId,
        "confirmed"
      );
    }

    await submitBidToAuction(bidderA, 100, closablePda); // slot 0
    await submitBidToAuction(bidderB, 200, closablePda); // slot 1

    // Wait until the auction deadline has passed before closing.
    const msUntilExpiry = (auctionEndTime + 1) * 1000 - Date.now();
    if (msUntilExpiry > 0) {
      console.log(`    Waiting ${Math.ceil(msUntilExpiry / 1000)}s for auction deadline...`);
      await new Promise((r) => setTimeout(r, msUntilExpiry));
    }

    // Listen for AuctionFinalized event.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let finalizedEvent: any = null;
    const listener = program.addEventListener("auctionFinalized", (e) => {
      finalizedEvent = e;
    });

    // Close + reveal.
    const revealOffset = new BN(randomBytes(8), "hex");
    await program.methods
      .closeAuction(revealOffset)
      .accountsPartial({
        payer: auctioneer.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        computationAccount: getComputationAccAddress(
          arciumEnv.arciumClusterOffset,
          revealOffset
        ),
        clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          compDefOffsetNum("reveal_winner")
        ),
        auction: closablePda,
      })
      .signers([auctioneer])
      .rpc({ commitment: "confirmed", skipPreflight: true });

    await awaitComputationFinalization(
      provider,
      revealOffset,
      program.programId,
      "confirmed"
    );
    await waitForAuctionStatus(closablePda, program, "finalized", 300_000);

    await program.removeEventListener(listener);

    const closable = await program.account.auction.fetch(closablePda);
    expect(closable.status).to.deep.equal({ finalized: {} });
    expect(closable.winnerIdx).to.not.be.null;
    expect(closable.winningPrice).to.not.be.null;

    // bidderB (slot 1) should win, paying the Vickrey price of 100.
    const winnerPubkey = closable.bidders[closable.winnerIdx as number];
    console.log("\n=== Blind Auction Result ===");
    console.log(`  Winner slot:  ${closable.winnerIdx}`);
    console.log(`  Winner:       ${winnerPubkey.toBase58()}`);
    console.log(`  Vickrey price: ${closable.winningPrice?.toString() ?? "?"}`);

    expect(closable.winnerIdx).to.equal(1); // bidderB is slot 1
    expect(closable.winningPrice?.toString()).to.equal("100"); // Vickrey = bidderA's bid

    if (finalizedEvent) {
      console.log(`  Event winner: ${finalizedEvent.winner.toBase58()}`);
      console.log(`  Event price:  ${finalizedEvent.winningPrice.toString()}`);
    }
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  after(async () => {
    if (!auctionPda) return;
    const auction = await program.account.auction.fetch(auctionPda);
    console.log("\n=== Main Auction Summary ===");
    console.log(`  Title:      ${auction.title}`);
    console.log(`  Bid count:  ${auction.bidCount}`);
    console.log(`  Status:     ${JSON.stringify(auction.status)}`);
  });
});
