# Blind Auctions — Privacy-Preserving Vickrey Auctions on Solana

[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://blind-auctions.vercel.app)
[![GitHub](https://img.shields.io/badge/github-repo-blue)](https://github.com/your-username/blind-auctions)

A fully on-chain Vickrey (second-price) blind auction system built on Solana using [Arcium](https://docs.arcium.com) MPC. Bid amounts are encrypted client-side with x25519 + RescueCipher and never visible to anyone — not the auctioneer, not other bidders, not the chain. The winner and Vickrey price are revealed privately by the Arcium MPC network.

## How It Works

```
Bidder                   Solana Program              Arcium MPC Network
  │                            │                             │
  │── encrypt bid (x25519) ───>│                             │
  │── cast_bid (ciphertext) ──>│── queue_computation ───────>│
  │                            │                             │ submit_bid circuit
  │                            │<── callback (new state_ct) ─│
  │                            │                             │
  │   [after deadline]         │                             │
  │── close_auction ──────────>│── queue_computation ───────>│
  │                            │                             │ reveal_winner circuit
  │                            │<── callback (winner, price) ─│
  │                            │ store winner_idx + winning_price
```

### Vickrey (Second-Price) Rules

- The highest bidder wins.
- The winner pays the **second-highest bid**, not their own.
- With only one bidder, the winner pays nothing.
- Bids are compared inside an encrypted MPC circuit — no plaintext is ever exposed.

### Encrypted State Machine

Three Arcis circuits run inside the MPC network:

| Circuit | Inputs | Output | When |
|---|---|---|---|
| `init_auction_state` | — | `Enc<Mxe, AuctionState{0,0,MAX}` | After `create_auction` |
| `submit_bid` | running state + encrypted bid | updated `Enc<Mxe, AuctionState>` | Each bid |
| `reveal_winner` | final running state | `(winner_idx, vickrey_price)` plaintext | After deadline |

The `AuctionState` struct (max_bid, second_bid, winner_idx) lives entirely inside the MPC engine. Only the encrypted ciphertext is stored on-chain.

---

## Project Structure

```
blind-auctions/
├── programs/blind-auctions/src/lib.rs   # Anchor program (instructions, accounts, errors)
├── encrypted-ixs/auctions.rs            # Arcis MPC circuits (submit_bid, reveal_winner)
├── frontend/                            # Next.js 14 app
│   └── src/
│       ├── app/                         # Pages (/, /create, /auction/[pubkey])
│       ├── components/                  # UI components
│       ├── hooks/                       # React Query mutations/queries
│       └── lib/                         # Program client, encryption, PDAs, constants
├── tests/blind-auctions.ts              # Integration tests (Anchor / Mocha)
└── scripts/
    ├── fix-circuits.ts                  # Robust circuit upload helper (handles 429s)
    └── init-comp-defs.ts                # Standalone comp def initialiser
```

---

## Prerequisites

- [Rust](https://rustup.rs/) + `solana-cli` 1.18+
- [Anchor CLI](https://www.anchor-lang.com/docs/installation) 0.32
- [Arcium CLI](https://docs.arcium.com/developers/installation) 0.8.5
- Node.js 18+ and Yarn
- A funded Solana devnet wallet at `~/.config/solana/id.json`

---

## Setup

```bash
# Install dependencies
yarn install

# Install frontend dependencies
cd frontend && npm install && cd ..
```

---

## Build & Deploy

### 1. Build the program and circuits

```bash
arcium build
```

Compiled circuits land in `build/*.arcis`.

### 2. Deploy the program

```bash
arcium deploy \
  --cluster-offset 456 \
  --keypair-path ~/.config/solana/id.json \
  --recovery-set-size 5 \
  --program-keypair target/deploy/blind_auctions-keypair.json \
  --program-name blind-auctions \
  --rpc-url devnet
```

### 3. Upload circuits

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
yarn ts-node scripts/fix-circuits.ts
```

This handles partial uploads, 429 rate-limit retries, and finalisation automatically.

### 4. Run integration tests

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
anchor test --skip-local-validator
```

The full test suite takes ~5–10 minutes on devnet due to MPC computation time.

---

## Frontend

```bash
cd frontend
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Pages

| Route | Description |
|---|---|
| `/` | Auction list — All / Mine / My Bids filters |
| `/create` | Create a new auction with duration picker (5m · 1h · 6h · 1d · 3d · 7d) |
| `/auction/[pubkey]` | Auction detail — bid form, status, reveal panel, refund |

### Credit System

Bidding requires credits (anti-spam deposit). Credits are free:
- Claim up to 10 per call via the faucet (60-second cooldown between claims).
- Placing a bid locks 1 credit.
- Losing bidders can reclaim their credit after the auction is finalized.
- Winners keep their credit spent.

---

## Key Design Decisions

### Concurrent Bid Guard

Only one bid computation can be in-flight at a time per auction. `cast_bid` sets `bid_in_flight = true`; the `submit_bid_callback` clears it. A second bidder attempting to bid while one is in-flight receives `BidInFlight` and must retry. This prevents a race condition where two simultaneous bids would read the same stale `state_ct`, causing one bid to be silently lost.

### Permissionless Close

`close_auction` can be called by any wallet once the deadline passes — not just the creator. This keeps the auction trustless: the winner, a third party, or an automated keeper can trigger the reveal without the creator needing to act.

### Auction Cancellation

If an auction's deadline passes with zero bids, the creator can call `cancel_auction` to close the account and recover the rent-exempt SOL. `close_auction` rejects zero-bid auctions, so this is the only recovery path.

### Slot Assignment

Bidder slot indices are assigned atomically inside `cast_bid` (incrementing `bid_count` before queuing the MPC computation). This ensures two simultaneous bids always land in different slots even if they pass the `bid_in_flight` guard at the same moment — though the in-flight guard makes that impossible in practice.

---

## Account Sizes

| Account | Space |
|---|---|
| `Auction` | 768 bytes |
| `BidRecord` | 86 bytes |
| `CreditAccount` | 57 bytes |

Maximum bidders per auction: **8**.

---

## Program ID

| Network | Address |
|---|---|
| Devnet | `CFtpyNqYpEyQu8LjAm5DRT4yJvdREyUB2syinV3DPT5Q` |

---

## Error Reference

| Code | Meaning |
|---|---|
| `BidInFlight` | A computation is already pending — retry after it finalizes |
| `InitInFlight` | Duplicate `init_auction_mpc` call while one is pending |
| `AuctionFull` | Maximum 8 bidders reached |
| `AuctionEnded` | Deadline has passed, no more bids accepted |
| `AuctionNotEnded` | Deadline has not passed yet, cannot close |
| `NoBids` | Cannot reveal winner with zero bids — use `cancel_auction` instead |
| `AuctionHasBids` | Cannot cancel an auction that has received bids |
| `WinnerCannotRefund` | Winners are not eligible for credit refund |
| `AlreadyRefunded` | Credit already refunded for this bid |
| `ClaimCooldown` | Must wait 60 seconds between faucet claims |
| `InsufficientCredits` | Need at least 1 credit to place a bid |
