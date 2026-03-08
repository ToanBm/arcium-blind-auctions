use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    /// Encrypted auction running state (MXE-owned, opaque to external parties).
    ///
    /// All fields are 256-bit field elements in the MPC engine; type bounds are
    /// enforced compile-time only.
    #[derive(Copy, Clone)]
    pub struct AuctionState {
        /// Highest bid seen so far.
        pub max_bid: u64,
        /// Second-highest bid seen so far (Vickrey price at reveal).
        pub second_bid: u64,
        /// Zero-based slot index of the highest bidder in `auction.bidders[]`.
        /// Sentinel `u64::MAX` = no winner yet.
        pub winner_idx: u64,
    }

    /// Initialise a new auction's encrypted running state to all-zeros.
    ///
    /// Called once after `create_auction`. Returns an MXE-encrypted zero state
    /// that serves as the seed for subsequent `submit_bid` calls.
    #[instruction]
    pub fn init_auction_state() -> Enc<Mxe, AuctionState> {
        let state = AuctionState {
            max_bid: 0u64,
            second_bid: 0u64,
            winner_idx: u64::MAX,
        };
        Mxe::get().from_arcis(state)
    }

    /// Update running state with a new bidder's encrypted bid.
    ///
    /// # Parameters
    /// - `running_state`: Current encrypted max/second/winner (MXE-owned).
    /// - `bidder_idx`:    Plaintext slot index for this bidder.
    /// - `bid_ctxt`:      Bidder's encrypted bid amount (Enc<Shared, u64>).
    ///
    /// # Algorithm (branchless — both branches always execute in MPC)
    /// ```text
    /// is_new_max    = bid > max_bid
    /// is_new_second = bid > second_bid  AND NOT is_new_max
    ///
    /// new_max    = is_new_max    ? bid      : max_bid
    /// new_second = is_new_max    ? max_bid  :
    ///              is_new_second ? bid      : second_bid
    /// new_winner = is_new_max    ? idx      : winner_idx
    /// ```
    #[instruction]
    pub fn submit_bid(
        running_state: Enc<Mxe, AuctionState>,
        bidder_idx: u64,
        /// Plaintext SOL ceiling deposited on-chain. The encrypted bid must not
        /// exceed this value — if it does, the bid is treated as zero, preventing
        /// a bidder from winning with an amount they cannot actually pay.
        ceiling: u64,
        bid_ctxt: Enc<Shared, u64>,
    ) -> Enc<Mxe, AuctionState> {
        let mut state = running_state.to_arcis();
        let raw_bid = bid_ctxt.to_arcis();

        // Enforce bid ≤ ceiling. A cheating bidder who encrypts a value above
        // their deposited ceiling has their bid silently zeroed.
        let bid = if raw_bid <= ceiling { raw_bid } else { 0u64 };

        let is_new_max = bid > state.max_bid;
        let is_new_second = !is_new_max && (bid > state.second_bid);

        let new_max    = if is_new_max    { bid }           else { state.max_bid    };
        let new_second = if is_new_max    { state.max_bid } else {
                         if is_new_second { bid }           else { state.second_bid }};
        let new_winner = if is_new_max    { bidder_idx }    else { state.winner_idx };

        state.max_bid    = new_max;
        state.second_bid = new_second;
        state.winner_idx = new_winner;

        running_state.owner.from_arcis(state)
    }

    /// Reveal the auction winner and Vickrey winning price.
    ///
    /// # Returns
    /// `(winner_idx, winning_price)` as plaintext u64 values:
    /// - `winner_idx`:    Index into `auction.bidders[]` on-chain.
    /// - `winning_price`: Second-highest bid (Vickrey rule).
    ///                    If only one bid was placed, equals the winning bid.
    #[instruction]
    pub fn reveal_winner(running_state: Enc<Mxe, AuctionState>) -> (u64, u64) {
        let state = running_state.to_arcis();
        // Vickrey: winner pays the second-highest bid.
        // If only one bid was placed, second_bid is 0 and the winner pays
        // nothing — standard single-bidder Vickrey behaviour (no reserve price).
        let winning_price = if state.second_bid == 0 {
            0u64
        } else {
            state.second_bid
        };
        (state.winner_idx.reveal(), winning_price.reveal())
    }
}
