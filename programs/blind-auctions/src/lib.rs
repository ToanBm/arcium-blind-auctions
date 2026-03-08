use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

declare_id!("CFtpyNqYpEyQu8LjAm5DRT4yJvdREyUB2syinV3DPT5Q");

// ---------------------------------------------------------------------------
// Computation definition offsets
// ---------------------------------------------------------------------------
const COMP_DEF_OFFSET_INIT_AUCTION_STATE: u32 = comp_def_offset("init_auction_state");
const COMP_DEF_OFFSET_SUBMIT_BID: u32 = comp_def_offset("submit_bid");
const COMP_DEF_OFFSET_REVEAL_WINNER: u32 = comp_def_offset("reveal_winner");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_TITLE_LEN: usize = 64;
const MAX_DESC_LEN: usize = 256;
const MAX_BIDDERS: usize = 8;

const AUCTION_SEED: &[u8] = b"auction";
const BID_RECORD_SEED: &[u8] = b"bid_record";
const VAULT_SEED: &[u8] = b"bid_vault";
const CREDIT_SEED: &[u8] = b"credit_account";
const MAX_CLAIM_AMOUNT: u64 = 10;
const CLAIM_COOLDOWN_SECS: i64 = 60; // minimum seconds between faucet claims

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[arcium_program]
pub mod blind_auctions {
    use super::*;

    // -----------------------------------------------------------------------
    // One-time computation definition initialization
    // -----------------------------------------------------------------------

    pub fn init_auction_state_comp_def(ctx: Context<InitAuctionStateCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_submit_bid_comp_def(ctx: Context<InitSubmitBidCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_reveal_winner_comp_def(ctx: Context<InitRevealWinnerCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Auction lifecycle
    // -----------------------------------------------------------------------

    /// Create a new auction. The encrypted state is not initialized yet —
    /// call `init_auction_mpc` next to seed it via MPC.
    pub fn create_auction(
        ctx: Context<CreateAuction>,
        auction_nonce: u64,
        title: String,
        description: String,
        end_time: i64,
    ) -> Result<()> {
        require!(title.len() <= MAX_TITLE_LEN, ErrorCode::TitleTooLong);
        require!(description.len() <= MAX_DESC_LEN, ErrorCode::DescriptionTooLong);
        require!(
            end_time > Clock::get()?.unix_timestamp,
            ErrorCode::EndTimeInPast
        );

        let auction = &mut ctx.accounts.auction;
        auction.creator = ctx.accounts.creator.key();
        auction.nonce = auction_nonce;
        auction.title = title;
        auction.description = description;
        auction.end_time = end_time;
        auction.bid_count = 0;
        auction.bid_in_flight = false;
        auction.init_queued = false;
        auction.bidders = [Pubkey::default(); MAX_BIDDERS];
        auction.state_ct = [[0u8; 32]; 3];
        auction.state_nonce = 0u128;
        auction.winner_idx = None;
        auction.winning_price = None;
        auction.status = AuctionStatus::Initializing;
        auction.bump = ctx.bumps.auction;
        Ok(())
    }

    /// Queue MPC to produce `Enc<Mxe, AuctionState>` initialized to zeros.
    pub fn init_auction_mpc(
        ctx: Context<InitAuctionMpc>,
        computation_offset: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.auction.status == AuctionStatus::Initializing,
            ErrorCode::InvalidAuctionStatus
        );
        require!(!ctx.accounts.auction.init_queued, ErrorCode::InitInFlight);

        ctx.accounts.auction.init_queued = true;
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let args = ArgBuilder::new().build();

        let callback_ix = InitAuctionStateCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[CallbackAccount {
                pubkey: ctx.accounts.auction.key(),
                is_writable: true,
            }],
        )?;
        queue_computation(ctx.accounts, computation_offset, args, vec![callback_ix], 1, 0)?;
        Ok(())
    }

    /// Callback: store encrypted zero state, activate the auction.
    #[arcium_callback(encrypted_ix = "init_auction_state")]
    pub fn init_auction_state_callback(
        ctx: Context<InitAuctionStateCallback>,
        output: SignedComputationOutputs<InitAuctionStateOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(InitAuctionStateOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let auction = &mut ctx.accounts.auction;
        auction.state_ct[0] = o.ciphertexts[0];
        auction.state_ct[1] = o.ciphertexts[1];
        auction.state_ct[2] = o.ciphertexts[2];
        auction.state_nonce = o.nonce;
        auction.init_queued = false;
        auction.status = AuctionStatus::Active;

        emit!(AuctionActivated { auction: auction.key() });
        Ok(())
    }

    /// Cast an encrypted bid. Each wallet may bid exactly once per auction.
    ///
    /// - `bid_ciphertext`: The bid amount encrypted with the bidder's x25519 / MXE shared secret.
    /// - `pub_key`:        Bidder's ephemeral x25519 public key.
    /// - `nonce`:          Encryption nonce for the bid.
    ///
    /// The bidder's slot index is assigned on-chain atomically before queuing
    /// so two simultaneous bids can never overwrite the same slot.
    pub fn cast_bid(
        ctx: Context<CastBid>,
        computation_offset: u64,
        ceiling: u64,
        bid_ciphertext: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
    ) -> Result<()> {
        require!(
            ctx.accounts.auction.status == AuctionStatus::Active,
            ErrorCode::InvalidAuctionStatus
        );
        require!(
            Clock::get()?.unix_timestamp < ctx.accounts.auction.end_time,
            ErrorCode::AuctionEnded
        );
        require!(
            ctx.accounts.auction.bid_count < MAX_BIDDERS as u8,
            ErrorCode::AuctionFull
        );
        require!(!ctx.accounts.auction.bid_in_flight, ErrorCode::BidInFlight);

        let auction = &mut ctx.accounts.auction;
        let bidder_idx = auction.bid_count as u64;

        // Lock the in-flight flag so no second bid can read stale state_ct
        // before this computation's callback has updated it.
        auction.bid_in_flight = true;
        // Atomically record this bidder's slot BEFORE queuing the computation.
        // This prevents two simultaneous bids from landing in the same slot.
        auction.bidders[bidder_idx as usize] = ctx.accounts.payer.key();
        auction.bid_count += 1;

        // Snapshot encrypted state for ArgBuilder AFTER updating bid_count/bidders.
        let state_nonce = auction.state_nonce;
        let state_ct = auction.state_ct;
        let auction_key = auction.key();

        // Lock 1 credit as participation stake.
        ctx.accounts.credit_account.balance -= 1;

        // Escrow the ceiling in lamports into the bidder's vault PDA.
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.bid_vault.to_account_info(),
                },
            ),
            ceiling,
        )?;

        // Initialize the BidRecord PDA (double-bid prevention: init fails if already exists).
        let bid_record = &mut ctx.accounts.bid_record;
        bid_record.bidder = ctx.accounts.payer.key();
        bid_record.auction = auction_key;
        bid_record.slot_idx = bidder_idx as u8;
        bid_record.ceiling = ceiling;
        bid_record.vault_bump = ctx.bumps.bid_vault;
        bid_record.credit_refunded = false;
        bid_record.settled = false;
        bid_record.escrow_withdrawn = false;
        bid_record.bump = ctx.bumps.bid_record;

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        // submit_bid(running_state, bidder_idx, bid_ctxt)
        // NOTE: ceiling is enforced on-chain via SOL escrow; the compiled circuit
        // does not include it as an MPC input. To add MPC-level enforcement,
        // re-add `ceiling: u64` to the ArgBuilder, rebuild and redeploy the circuit.
        let args = ArgBuilder::new()
            .plaintext_u128(state_nonce)     // Enc<Mxe, AuctionState>: nonce
            .encrypted_u8(state_ct[0])       // Enc<Mxe, AuctionState>: max_bid ct
            .encrypted_u8(state_ct[1])       // Enc<Mxe, AuctionState>: second_bid ct
            .encrypted_u8(state_ct[2])       // Enc<Mxe, AuctionState>: winner_idx ct
            .plaintext_u64(bidder_idx)       // plaintext slot index
            .x25519_pubkey(pub_key)          // Enc<Shared, u64>: bidder's ephemeral key
            .plaintext_u128(nonce)           // Enc<Shared, u64>: nonce
            .encrypted_u8(bid_ciphertext)    // Enc<Shared, u64>: encrypted bid
            .build();

        let callback_ix = SubmitBidCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[CallbackAccount {
                pubkey: ctx.accounts.auction.key(),
                is_writable: true,
            }],
        )?;
        queue_computation(ctx.accounts, computation_offset, args, vec![callback_ix], 1, 0)?;
        Ok(())
    }

    /// Callback: store updated encrypted state after a bid is registered.
    #[arcium_callback(encrypted_ix = "submit_bid")]
    pub fn submit_bid_callback(
        ctx: Context<SubmitBidCallback>,
        output: SignedComputationOutputs<SubmitBidOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(SubmitBidOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let auction = &mut ctx.accounts.auction;
        auction.state_ct[0] = o.ciphertexts[0];
        auction.state_ct[1] = o.ciphertexts[1];
        auction.state_ct[2] = o.ciphertexts[2];
        auction.state_nonce = o.nonce;
        auction.bid_in_flight = false;

        emit!(BidRegistered {
            auction: auction.key(),
            bid_count: auction.bid_count,
        });
        Ok(())
    }

    /// Close an active auction after the deadline and queue winner revelation.
    ///
    /// Intentionally permissionless — any wallet can trigger this once the
    /// deadline has passed. This keeps the auction trustless: the winner or any
    /// third party can reveal results without needing the creator to act. The
    /// caller pays only the MPC fee for the reveal computation.
    pub fn close_auction(
        ctx: Context<CloseAuction>,
        computation_offset: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.auction.status == AuctionStatus::Active,
            ErrorCode::InvalidAuctionStatus
        );
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.auction.end_time,
            ErrorCode::AuctionNotEnded
        );
        require!(
            ctx.accounts.auction.bid_count > 0,
            ErrorCode::NoBids
        );

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let state_nonce = ctx.accounts.auction.state_nonce;
        let state_ct = ctx.accounts.auction.state_ct;

        // reveal_winner(running_state: Enc<Mxe, AuctionState>)
        let args = ArgBuilder::new()
            .plaintext_u128(state_nonce)
            .encrypted_u8(state_ct[0])
            .encrypted_u8(state_ct[1])
            .encrypted_u8(state_ct[2])
            .build();

        let callback_ix = RevealWinnerCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[CallbackAccount {
                pubkey: ctx.accounts.auction.key(),
                is_writable: true,
            }],
        )?;
        queue_computation(ctx.accounts, computation_offset, args, vec![callback_ix], 1, 0)?;

        ctx.accounts.auction.status = AuctionStatus::Closed;
        Ok(())
    }

    /// Callback: store revealed winner index and Vickrey price; finalize auction.
    #[arcium_callback(encrypted_ix = "reveal_winner")]
    pub fn reveal_winner_callback(
        ctx: Context<RevealWinnerCallback>,
        output: SignedComputationOutputs<RevealWinnerOutput>,
    ) -> Result<()> {
        // reveal_winner returns (u64, u64) — Arcium wraps the entire tuple as field_0,
        // with the tuple's elements accessible as field_0.field_0 and field_0.field_1.
        let tuple_out = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(RevealWinnerOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };
        let (winner_idx_raw, winning_price) = (tuple_out.field_0, tuple_out.field_1);

        let auction = &mut ctx.accounts.auction;
        // Clamp winner_idx to valid range (sanity check).
        let winner_idx = (winner_idx_raw as u8).min(auction.bid_count.saturating_sub(1));
        auction.winner_idx = Some(winner_idx);
        auction.winning_price = Some(winning_price);
        auction.status = AuctionStatus::Finalized;

        let winner_pubkey = auction.bidders[winner_idx as usize];

        emit!(AuctionFinalized {
            auction: auction.key(),
            winner: winner_pubkey,
            winning_price,
        });
        Ok(())
    }

    /// Claim free credits from the faucet (up to MAX_CLAIM_AMOUNT per call).
    /// Enforces a per-wallet cooldown of CLAIM_COOLDOWN_SECS between claims.
    pub fn claim_credits(ctx: Context<ClaimCredits>, amount: u64) -> Result<()> {
        require!(
            amount >= 1 && amount <= MAX_CLAIM_AMOUNT,
            ErrorCode::InvalidClaimAmount
        );
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.credit_account;
        if c.owner == Pubkey::default() {
            // First-time initialisation via init_if_needed — no cooldown yet.
            c.owner = ctx.accounts.user.key();
            c.bump = ctx.bumps.credit_account;
        } else {
            require!(
                now >= c.last_claim_time + CLAIM_COOLDOWN_SECS,
                ErrorCode::ClaimCooldown
            );
        }
        c.balance += amount;
        c.last_claim_time = now;
        Ok(())
    }

    /// Settle the auction: transfer the Vickrey price to the creator and refund
    /// the remainder to the winner. Callable by anyone after finalization.
    pub fn settle_auction(ctx: Context<SettleAuction>) -> Result<()> {
        require!(
            ctx.accounts.auction.status == AuctionStatus::Finalized,
            ErrorCode::AuctionNotFinalized
        );
        let winner_idx = ctx.accounts.auction.winner_idx.ok_or(ErrorCode::AuctionNotFinalized)?;
        let winning_price = ctx.accounts.auction.winning_price.ok_or(ErrorCode::AuctionNotFinalized)?;

        let bid_record = &mut ctx.accounts.bid_record;
        require!(bid_record.slot_idx == winner_idx, ErrorCode::NotWinner);
        require!(!bid_record.settled, ErrorCode::AlreadySettled);
        bid_record.settled = true;

        let ceiling = bid_record.ceiling;
        let winner_key = bid_record.bidder;
        let auction_key = ctx.accounts.auction.key();
        let vault_bump = bid_record.vault_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            VAULT_SEED, winner_key.as_ref(), auction_key.as_ref(), &[vault_bump],
        ]];

        // Pay the Vickrey price to the auction creator.
        let pay_amount = winning_price.min(ceiling);
        if pay_amount > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.bid_vault.to_account_info(),
                        to: ctx.accounts.creator.to_account_info(),
                    },
                    signer_seeds,
                ),
                pay_amount,
            )?;
        }

        // Refund the remaining escrow (ceiling − winning_price) to the winner.
        let refund = ceiling.saturating_sub(pay_amount);
        if refund > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.bid_vault.to_account_info(),
                        to: ctx.accounts.winner.to_account_info(),
                    },
                    signer_seeds,
                ),
                refund,
            )?;
        }
        Ok(())
    }

    /// Withdraw the full SOL escrow for a losing bidder after finalization.
    pub fn withdraw_escrow(ctx: Context<WithdrawEscrow>) -> Result<()> {
        require!(
            ctx.accounts.auction.status == AuctionStatus::Finalized,
            ErrorCode::AuctionNotFinalized
        );
        let winner_idx = ctx.accounts.auction.winner_idx.ok_or(ErrorCode::AuctionNotFinalized)?;

        let bid_record = &mut ctx.accounts.bid_record;
        require!(bid_record.slot_idx != winner_idx, ErrorCode::WinnerMustSettle);
        require!(!bid_record.escrow_withdrawn, ErrorCode::AlreadyWithdrawn);
        bid_record.escrow_withdrawn = true;

        let ceiling = bid_record.ceiling;
        let bidder_key = bid_record.bidder;
        let auction_key = ctx.accounts.auction.key();
        let vault_bump = bid_record.vault_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            VAULT_SEED, bidder_key.as_ref(), auction_key.as_ref(), &[vault_bump],
        ]];

        anchor_lang::system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.bid_vault.to_account_info(),
                    to: ctx.accounts.bidder.to_account_info(),
                },
                signer_seeds,
            ),
            ceiling,
        )?;
        Ok(())
    }

    /// Cancel an auction that has passed its deadline with zero bids.
    ///
    /// Closes the auction account and refunds the rent-exempt lamports to the
    /// creator. This is the only way to reclaim SOL from an auction that nobody
    /// bid on — `close_auction` rejects auctions with `bid_count == 0`.
    pub fn cancel_auction(ctx: Context<CancelAuction>) -> Result<()> {
        require!(
            ctx.accounts.auction.status == AuctionStatus::Active,
            ErrorCode::InvalidAuctionStatus
        );
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.auction.end_time,
            ErrorCode::AuctionNotEnded
        );
        require!(
            ctx.accounts.auction.bid_count == 0,
            ErrorCode::AuctionHasBids
        );
        // Anchor closes the account and returns lamports via `close = creator`.
        Ok(())
    }

    /// Refund the participation credit to a non-winning bidder after finalization.
    pub fn refund_credit(ctx: Context<RefundCredit>) -> Result<()> {
        require!(
            ctx.accounts.auction.status == AuctionStatus::Finalized,
            ErrorCode::AuctionNotFinalized
        );
        let bid_record = &mut ctx.accounts.bid_record;
        require!(!bid_record.credit_refunded, ErrorCode::AlreadyRefunded);
        let winner_idx = ctx
            .accounts
            .auction
            .winner_idx
            .ok_or(ErrorCode::AuctionNotFinalized)?;
        require!(
            bid_record.slot_idx != winner_idx,
            ErrorCode::WinnerCannotRefund
        );
        bid_record.credit_refunded = true;
        ctx.accounts.credit_account.balance += 1;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account structs — comp def init
// ---------------------------------------------------------------------------

#[init_computation_definition_accounts("init_auction_state", payer)]
#[derive(Accounts)]
pub struct InitAuctionStateCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("submit_bid", payer)]
#[derive(Accounts)]
pub struct InitSubmitBidCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("reveal_winner", payer)]
#[derive(Accounts)]
pub struct InitRevealWinnerCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Account structs — queue computation
// ---------------------------------------------------------------------------

#[queue_computation_accounts("init_auction_state", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct InitAuctionMpc<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_AUCTION_STATE))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    #[account(mut)]
    pub auction: Account<'info, Auction>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("init_auction_state")]
#[derive(Accounts)]
pub struct InitAuctionStateCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_INIT_AUCTION_STATE))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub auction: Account<'info, Auction>,
}

// ---------------------------------------------------------------------------

#[queue_computation_accounts("submit_bid", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct CastBid<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SUBMIT_BID))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    #[account(mut)]
    pub auction: Box<Account<'info, Auction>>,
    /// SOL escrow vault for this bidder. Receives `ceiling` lamports at bid time;
    /// drained at settle (winner) or withdraw (losers) after finalization.
    /// CHECK: PDA verified by seeds — a plain system account holding lamports.
    #[account(
        mut,
        seeds = [VAULT_SEED, payer.key().as_ref(), auction.key().as_ref()],
        bump,
    )]
    pub bid_vault: UncheckedAccount<'info>,
    /// PDA uniqueness = double-bid prevention (init fails if bidder already bid)
    #[account(
        init,
        payer = payer,
        space = BidRecord::SPACE,
        seeds = [BID_RECORD_SEED, payer.key().as_ref(), auction.key().as_ref()],
        bump,
    )]
    pub bid_record: Account<'info, BidRecord>,
    #[account(
        mut,
        seeds = [CREDIT_SEED, payer.key().as_ref()],
        bump = credit_account.bump,
        constraint = credit_account.balance >= 1 @ ErrorCode::InsufficientCredits,
    )]
    pub credit_account: Account<'info, CreditAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("submit_bid")]
#[derive(Accounts)]
pub struct SubmitBidCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_SUBMIT_BID))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub auction: Account<'info, Auction>,
}

// ---------------------------------------------------------------------------

#[queue_computation_accounts("reveal_winner", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct CloseAuction<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_WINNER))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    #[account(mut)]
    pub auction: Account<'info, Auction>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("reveal_winner")]
#[derive(Accounts)]
pub struct RevealWinnerCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_WINNER))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub auction: Account<'info, Auction>,
}

// ---------------------------------------------------------------------------
// Account structs — create_auction
// ---------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(auction_nonce: u64)]
pub struct CreateAuction<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = Auction::MAX_SPACE,
        seeds = [AUCTION_SEED, creator.key().as_ref(), &auction_nonce.to_le_bytes()],
        bump,
    )]
    pub auction: Account<'info, Auction>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Data accounts
// ---------------------------------------------------------------------------

#[account]
pub struct Auction {
    /// Creator of this auction.
    pub creator: Pubkey,
    /// Nonce used to derive this auction's PDA (caller-supplied random u64).
    pub nonce: u64,
    /// Human-readable title.
    pub title: String,
    /// Human-readable description.
    pub description: String,
    /// Unix timestamp after which the auction can be closed.
    pub end_time: i64,
    /// Number of bids submitted so far (≤ MAX_BIDDERS).
    pub bid_count: u8,
    /// True while an MPC `submit_bid` computation is in-flight.
    /// Prevents a second bid from reading stale `state_ct` before the first
    /// callback has updated it, which would silently drop the earlier bid.
    pub bid_in_flight: bool,
    /// True after `init_auction_mpc` has queued the initialisation computation,
    /// cleared once the callback lands. Prevents a duplicate init computation
    /// from racing with the first one.
    pub init_queued: bool,
    /// Bidder public keys in submission order. `bidders[i]` corresponds to
    /// slot index `i` in the encrypted AuctionState.
    pub bidders: [Pubkey; MAX_BIDDERS],
    /// Encrypted AuctionState ciphertexts: [max_bid_ct, second_bid_ct, winner_idx_ct].
    pub state_ct: [[u8; 32]; 3],
    /// Shared nonce for the encrypted AuctionState.
    pub state_nonce: u128,
    /// Winner slot index (set at finalization).
    pub winner_idx: Option<u8>,
    /// Winning price: second-highest bid, revealed at finalization (Vickrey).
    pub winning_price: Option<u64>,
    /// Lifecycle status.
    pub status: AuctionStatus,
    pub bump: u8,
}

impl Auction {
    /// 8 discriminator + 32 creator + 8 nonce
    /// + (4 + MAX_TITLE_LEN) title + (4 + MAX_DESC_LEN) description
    /// + 8 end_time + 1 bid_count + 1 bid_in_flight + 1 init_queued
    /// + MAX_BIDDERS*32 bidders
    /// + 3*32 state_ct + 16 state_nonce
    /// + 2 winner_idx (Option<u8>) + 9 winning_price (Option<u64>)
    /// + 1 status + 1 bump
    pub const MAX_SPACE: usize = 8
        + 32 + 8
        + (4 + MAX_TITLE_LEN) + (4 + MAX_DESC_LEN)
        + 8 + 1 + 1 + 1
        + MAX_BIDDERS * 32
        + 3 * 32 + 16
        + 2 + 9
        + 1 + 1;
}

#[account]
pub struct BidRecord {
    pub bidder: Pubkey,
    pub auction: Pubkey,
    pub slot_idx: u8,
    /// Lamports deposited into the bidder's vault PDA at bid time.
    /// Equals the plaintext ceiling passed to the MPC circuit.
    pub ceiling: u64,
    /// Bump for the bid_vault PDA — stored so settle/withdraw can sign.
    pub vault_bump: u8,
    pub credit_refunded: bool,
    /// True once the winner has called `settle_auction`.
    pub settled: bool,
    /// True once a loser has called `withdraw_escrow`.
    pub escrow_withdrawn: bool,
    pub bump: u8,
}

impl BidRecord {
    /// 8 disc + 32 bidder + 32 auction + 1 slot_idx
    /// + 8 ceiling + 1 vault_bump + 1 credit_refunded
    /// + 1 settled + 1 escrow_withdrawn + 1 bump
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 8 + 1 + 1 + 1 + 1 + 1; // 86
}

#[account]
pub struct CreditAccount {
    pub owner: Pubkey,
    pub balance: u64,
    /// Unix timestamp of the last successful `claim_credits` call.
    /// Zero until the first claim is made.
    pub last_claim_time: i64,
    pub bump: u8,
}

impl CreditAccount {
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 1; // +8 for last_claim_time
}

// ---------------------------------------------------------------------------
// Account structs — credit system
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct ClaimCredits<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        init_if_needed,
        space = CreditAccount::SPACE,
        payer = user,
        seeds = [CREDIT_SEED, user.key().as_ref()],
        bump,
    )]
    pub credit_account: Account<'info, CreditAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefundCredit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [CREDIT_SEED, user.key().as_ref()],
        bump = credit_account.bump,
    )]
    pub credit_account: Account<'info, CreditAccount>,
    #[account(
        mut,
        seeds = [BID_RECORD_SEED, user.key().as_ref(), auction.key().as_ref()],
        bump = bid_record.bump,
        constraint = bid_record.bidder == user.key() @ ErrorCode::InvalidBidRecord,
    )]
    pub bid_record: Account<'info, BidRecord>,
    pub auction: Account<'info, Auction>,
}

#[derive(Accounts)]
pub struct SettleAuction<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The auction creator — receives the Vickrey price.
    /// CHECK: checked via auction.creator constraint below.
    #[account(mut, constraint = creator.key() == auction.creator @ ErrorCode::Unauthorized)]
    pub creator: AccountInfo<'info>,
    /// The winning bidder — receives the ceiling − winning_price refund.
    /// CHECK: checked via bid_record.bidder constraint below.
    #[account(mut, constraint = winner.key() == bid_record.bidder @ ErrorCode::NotWinner)]
    pub winner: AccountInfo<'info>,
    pub auction: Account<'info, Auction>,
    #[account(
        mut,
        seeds = [BID_RECORD_SEED, bid_record.bidder.as_ref(), auction.key().as_ref()],
        bump = bid_record.bump,
    )]
    pub bid_record: Account<'info, BidRecord>,
    /// CHECK: SOL vault PDA — holds the winner's escrowed lamports.
    #[account(
        mut,
        seeds = [VAULT_SEED, bid_record.bidder.as_ref(), auction.key().as_ref()],
        bump = bid_record.vault_bump,
    )]
    pub bid_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawEscrow<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    pub auction: Account<'info, Auction>,
    #[account(
        mut,
        seeds = [BID_RECORD_SEED, bidder.key().as_ref(), auction.key().as_ref()],
        bump = bid_record.bump,
        constraint = bid_record.bidder == bidder.key() @ ErrorCode::InvalidBidRecord,
    )]
    pub bid_record: Account<'info, BidRecord>,
    /// CHECK: SOL vault PDA — holds the loser's escrowed lamports.
    #[account(
        mut,
        seeds = [VAULT_SEED, bidder.key().as_ref(), auction.key().as_ref()],
        bump = bid_record.vault_bump,
    )]
    pub bid_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelAuction<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        mut,
        seeds = [AUCTION_SEED, creator.key().as_ref(), &auction.nonce.to_le_bytes()],
        bump = auction.bump,
        constraint = auction.creator == creator.key() @ ErrorCode::Unauthorized,
        close = creator,
    )]
    pub auction: Account<'info, Auction>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum AuctionStatus {
    /// Created, encrypted state not yet initialized via MPC.
    Initializing,
    /// Accepting bids.
    Active,
    /// Deadline passed; winner computation queued.
    Closed,
    /// Winner and price revealed.
    Finalized,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct AuctionActivated {
    pub auction: Pubkey,
}

#[event]
pub struct BidRegistered {
    pub auction: Pubkey,
    pub bid_count: u8,
}

#[event]
pub struct AuctionFinalized {
    pub auction: Pubkey,
    pub winner: Pubkey,
    pub winning_price: u64,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("MPC cluster not configured")]
    ClusterNotSet,
    #[msg("Auction title exceeds 64 characters")]
    TitleTooLong,
    #[msg("Auction description exceeds 256 characters")]
    DescriptionTooLong,
    #[msg("End time must be in the future")]
    EndTimeInPast,
    #[msg("Auction is not in the expected status for this operation")]
    InvalidAuctionStatus,
    #[msg("Auction bidding period has ended")]
    AuctionEnded,
    #[msg("Auction deadline has not yet passed")]
    AuctionNotEnded,
    #[msg("Auction has reached maximum bidder capacity")]
    AuctionFull,
    #[msg("No bids were placed — cannot determine a winner")]
    NoBids,
    #[msg("Claim amount must be between 1 and 10")]
    InvalidClaimAmount,
    #[msg("Insufficient credits — claim credits before bidding")]
    InsufficientCredits,
    #[msg("Auction is not yet finalized")]
    AuctionNotFinalized,
    #[msg("Credit already refunded for this bid")]
    AlreadyRefunded,
    #[msg("Winners cannot reclaim their participation credit")]
    WinnerCannotRefund,
    #[msg("Bid record does not belong to this user")]
    InvalidBidRecord,
    #[msg("A bid computation is already in flight — wait for it to finalize before bidding again")]
    BidInFlight,
    #[msg("An initialization computation is already in flight for this auction")]
    InitInFlight,
    #[msg("Cannot cancel an auction that has received bids")]
    AuctionHasBids,
    #[msg("Only the auction creator can perform this action")]
    Unauthorized,
    #[msg("Credits claimed too recently — wait 60 seconds between claims")]
    ClaimCooldown,
    #[msg("Only the winning bidder's record can be settled")]
    NotWinner,
    #[msg("Auction has already been settled")]
    AlreadySettled,
    #[msg("Escrow has already been withdrawn")]
    AlreadyWithdrawn,
    #[msg("Winner must call settle_auction, not withdraw_escrow")]
    WinnerMustSettle,
}
