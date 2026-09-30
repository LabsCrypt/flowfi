use soroban_sdk::contracterror;

/// Exhaustive error surface for `StreamContract`.
///
/// Each variant maps to a unique u32 so that clients and indexers can
/// distinguish failures without parsing error messages.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum StreamError {
    /// `amount` supplied to a stream-creation or top-up entrypoint is ≤ 0,
    /// or `withdraw` was called when nothing is claimable yet (fully vested
    /// tokens have already been withdrawn).
    ///
    /// Returned by: `create_stream`, `create_step_vesting_stream`,
    /// `create_hybrid_cliff_stream`, `top_up_stream`, `withdraw`.
    InvalidAmount = 1,

    /// No stream record exists for the supplied `stream_id`.
    ///
    /// Returned by: every entrypoint that accepts a `stream_id`
    /// (`withdraw`, `cancel_stream`, `pause_stream`, `resume_stream`,
    /// `top_up_stream`, `close_stream`, `batch_withdraw`, `modify_rate`,
    /// `request_dispute`, `resolve_dispute`) via `load_stream` in storage.
    StreamNotFound = 2,

    /// The caller is not authorised to act on this stream.
    /// For sender-only operations (cancel, pause, top-up, modify-rate,
    /// request-dispute) the caller must equal `stream.sender`; for `withdraw`
    /// and `batch_withdraw` the caller must equal `stream.recipient`; for
    /// `close_stream` the caller must be the sender, recipient, or protocol
    /// admin.
    ///
    /// Returned by: `withdraw`, `cancel_stream`, `close_stream`,
    /// `pause_stream`, `resume_stream`, `top_up_stream`, `batch_withdraw`,
    /// `modify_rate`, `request_dispute`.
    Unauthorized = 3,

    /// The stream has already been cancelled or fully drained
    /// (`is_active == false`) and can no longer accept state-changing
    /// operations.
    ///
    /// Returned by: `top_up_stream`, `cancel_stream`, `pause_stream`,
    /// `request_dispute` (via `validate_stream_active`).
    StreamInactive = 4,

    /// `initialize` has already been called; the protocol config already exists
    /// and cannot be overwritten.
    ///
    /// Returned by: `initialize`.
    AlreadyInitialized = 5,

    /// The caller is not the protocol admin stored in `ProtocolConfig::admin`.
    ///
    /// Returned by: `update_fee_config`, `transfer_admin`,
    /// `set_emergency_guardian`, `upgrade`, `migrate`, and the unpause path of
    /// `set_protocol_pause` (only the admin may clear the circuit breaker).
    NotAdmin = 6,

    /// `fee_rate_bps` exceeds `MAX_FEE_RATE_BPS` (1 000 bps = 10%).
    ///
    /// Returned by: `initialize`, `update_fee_config`.
    InvalidFeeRate = 7,

    /// The protocol has not been initialized yet (`DataKey::Config` is absent
    /// from storage).
    ///
    /// Returned by every admin entrypoint that calls `load_config`: `upgrade`,
    /// `migrate`, `update_fee_config`, `transfer_admin`,
    /// `set_emergency_guardian`, `set_protocol_pause`.
    NotInitialized = 8,

    /// `duration` passed to the stream-creation entrypoint is 0. A zero-length
    /// stream would be immediately expired and could never accrue.
    ///
    /// Returned by: `create_stream`, `create_allowance_stream`.
    InvalidDuration = 9,

    /// The supplied token address does not implement the Soroban token interface
    /// (calling `decimals()` on it failed or reverted).
    ///
    /// Returned by: `create_stream`, `create_step_vesting_stream`,
    /// `create_hybrid_cliff_stream`, `create_allowance_stream`
    /// (via `validate_token_contract`).
    InvalidTokenAddress = 10,

    /// `net_amount / duration` rounds down to zero under integer division —
    /// the stream would lock the sender's tokens in the contract while never
    /// accruing anything to the recipient. Almost always caused by wrong token
    /// decimals or an excessively long duration.
    ///
    /// Returned by: `create_stream`.
    InvalidRate = 11,

    /// `withdraw` was called on a stream that is currently paused by its
    /// sender. Call `resume_stream` first, then retry the withdrawal.
    ///
    /// Returned by: `withdraw`.
    StreamPaused = 12,

    /// `resume_stream` was called on a stream that is active but **not**
    /// currently paused (i.e., `stream.paused == false`).
    ///
    /// Returned by: `resume_stream`.
    StreamNotPaused = 13,

    /// `pause_stream` was called on a stream that is already paused
    /// (`stream.paused == true`).
    ///
    /// Returned by: `pause_stream`.
    StreamAlreadyPaused = 14,

    /// The protocol circuit breaker is engaged (`is_protocol_paused == true`).
    /// All token-in entrypoints are blocked while the breaker is tripped;
    /// token-out entrypoints (`withdraw`, `batch_withdraw`, `cancel_stream`)
    /// remain open so that already-vested funds are never trapped.
    ///
    /// Returned by: `create_stream`, `create_step_vesting_stream`,
    /// `create_hybrid_cliff_stream`, `top_up_stream`,
    /// `create_allowance_stream` (via `require_not_protocol_paused`).
    ProtocolPaused = 15,

    /// A step-tranche schedule was submitted with an empty `steps` vector.
    /// At least one unlock step is required.
    ///
    /// Returned by: `create_step_vesting_stream`.
    EmptyVestingSchedule = 16,

    /// The `steps` vector contains more entries than `MAX_VESTING_STEPS`.
    ///
    /// Returned by: `create_step_vesting_stream`.
    TooManyVestingSteps = 17,

    /// Two consecutive steps share the same `unlock_time`, or a step's
    /// `unlock_time` is earlier than the previous step's. The schedule must be
    /// strictly monotonically increasing so that
    /// `sum(steps where unlock_time <= T)` is unambiguous at every boundary.
    ///
    /// Returned by: `create_step_vesting_stream`
    /// (via `validate_step_schedule`).
    NonMonotonicVestingSteps = 18,

    /// A step's `unlock_amount` is ≤ 0. Every tranche must unlock a strictly
    /// positive number of tokens.
    ///
    /// Returned by: `create_step_vesting_stream`
    /// (via `validate_step_schedule`).
    InvalidVestingStepAmount = 19,

    /// The sum of all step `unlock_amount` values does not equal the post-fee
    /// net deposited amount. Every token deposited must be assigned to exactly
    /// one unlock milestone.
    ///
    /// Returned by: `create_step_vesting_stream`
    /// (via `validate_step_schedule`).
    VestingStepTotalMismatch = 20,

    /// A step's `unlock_time` is ≤ the stream's `start_time`. Every unlock
    /// must occur strictly after the stream begins so that no tokens are
    /// instantly claimable at creation.
    ///
    /// Returned by: `create_step_vesting_stream`
    /// (via `validate_step_schedule`).
    VestingStepBeforeStart = 21,

    /// One or more hybrid-cliff parameters are invalid. The exact conditions:
    /// - `linear_duration == 0` (no linear tail);
    /// - `cliff_time <= start_time` (cliff must be strictly in the future);
    /// - `cliff_unlock_amount <= 0` or `>= net_amount` (must leave a non-zero
    ///   linear portion);
    /// - `(net_amount - cliff_unlock_amount) / linear_duration == 0` (the
    ///   post-cliff rate rounds to zero under integer division).
    ///
    /// Returned by: `create_hybrid_cliff_stream`.
    InvalidCliffParameters = 22,

    /// `batch_withdraw` was given more stream IDs than `MAX_BATCH_WITHDRAW`
    /// allows in a single transaction.
    ///
    /// Returned by: `batch_withdraw`.
    BatchTooLarge = 23,

    /// The caller attempted to trip the circuit breaker but is neither the
    /// protocol admin nor the configured emergency guardian.
    ///
    /// Note: the *unpause* path returns `NotAdmin` instead, because only the
    /// admin may clear the breaker — a compromised guardian must only ever be
    /// able to *increase* restrictions, never lift them.
    ///
    /// Returned by: `set_protocol_pause` (pause path only).
    NotGuardian = 24,

    /// `migrate` was called with a `target_version` that this contract binary
    /// cannot write (greater than `CURRENT_DATA_VERSION`) or that would be a
    /// downgrade (less than the current on-chain version).
    ///
    /// Returned by: `migrate`.
    UnsupportedMigration = 25,

    /// The on-chain `DataKey::ContractVersion` is already newer than
    /// `CURRENT_DATA_VERSION`, meaning a newer binary previously wrote the
    /// state and this binary cannot safely interpret or overwrite it.
    ///
    /// Returned by: `migrate`.
    StateVersionTooNew = 26,

    /// `top_up_stream` was called on a step-tranche stream
    /// (`VestingSchedule::StepTranches`). A step schedule must sum to exactly
    /// the deposited amount, so additional tokens have nowhere to go: appending
    /// them to the final step would silently defer the top-up to the last
    /// milestone, and ignoring them would strand them as unclaimable residue.
    /// Rejecting is the only option that never misrepresents when the recipient
    /// receives their funds.
    ///
    /// Returned by: `top_up_stream`.
    TopUpUnsupported = 27,

    /// `modify_rate` was called on a stream whose schedule is not
    /// `VestingSchedule::Linear`. Step-tranche and hybrid-cliff streams are
    /// anchored to absolute unlock timestamps rather than a continuous rate, so
    /// a rate modification has no defined meaning for them.
    ///
    /// Returned by: `modify_rate`.
    RateModificationUnsupported = 28,

    /// `new_rate_per_second` supplied to `modify_rate` is ≤ 0. A non-positive
    /// rate would make the stream's projected end-time undefined or infinite.
    ///
    /// Returned by: `modify_rate`.
    InvalidNewRate = 29,

    /// A dispute operation was attempted on a stream that has no arbiter
    /// configured (`stream.arbiter == None`). An arbiter must be set at stream
    /// creation for dispute resolution to be available.
    ///
    /// Returned by: `request_dispute`, `resolve_dispute`.
    DisputeNotSupported = 30,

    /// `resolve_dispute` was called but the stream's `dispute_status` is not
    /// `DisputeStatus::Requested` — either no dispute was ever filed, or it
    /// has already been resolved.
    ///
    /// Returned by: `resolve_dispute`.
    NoActiveDispute = 31,

    /// The caller of `resolve_dispute` does not match the arbiter address
    /// stored in `stream.arbiter`.
    ///
    /// Returned by: `resolve_dispute`.
    NotArbiter = 32,

    /// `create_allowance_stream` detected that the sender has not granted the
    /// contract a positive token allowance, or the allowance query itself
    /// failed. The sender must pre-approve the contract on the token contract
    /// before calling this entrypoint.
    ///
    /// Returned by: `create_allowance_stream`.
    AllowanceLocked = 33,

    /// An arithmetic operation overflowed its integer type. Specific triggers:
    /// - **Fee calculation** — `amount × fee_rate_bps` overflows `i128` in
    ///   `collect_fee`.
    /// - **Withdrawal accounting** — `withdrawn_amount + claimable` overflows
    ///   `i128` in `apply_withdrawal`.
    /// - **End-time projection** — `remaining / rate` does not fit in `u64`,
    ///   or `now + seconds_remaining` overflows `u64` in `project_end_time`.
    ///
    /// Returned by: `top_up_stream`, `resume_stream`, `modify_rate`
    /// (via `project_end_time`), and any entrypoint that calls `collect_fee`
    /// or `apply_withdrawal` with an extreme token amount.
    ArithmeticOverflow = 34,

    /// `close_stream` was called on a stream that is not yet eligible for
    /// on-chain pruning. This covers four distinct conditions checked in order:
    /// - `stream.is_active == true` (stream is still running or paused).
    /// - `stream.status` is neither `Completed` nor `Cancelled`.
    /// - A completed stream still has `deposited_amount != withdrawn_amount`.
    /// - A completed stream still has a non-zero claimable balance at the
    ///   current ledger timestamp.
    ///
    /// Returned by: `close_stream`.
    StreamStillActive = 35,

    /// `resume_stream` was called on a stream whose `is_active` flag is
    /// `false` (i.e., the stream has been cancelled or fully completed and
    /// cannot be resumed). Distinct from `StreamNotPaused`, which applies
    /// to a stream that is still active but not currently paused.
    ///
    /// Returned by: `resume_stream`.
    StreamNotActive = 36,
}
