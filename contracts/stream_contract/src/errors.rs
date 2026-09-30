use soroban_sdk::contracterror;

/// Exhaustive error surface for `StreamContract`.
///
/// Each variant maps to a unique u32 so that clients and indexers can
/// distinguish failures without parsing error messages.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum StreamError {
    /// Amount is zero, negative, or otherwise out of range.
    InvalidAmount = 1,
    /// No stream exists for the supplied ID.
    StreamNotFound = 2,
    /// Caller is not authorised to perform this action on the stream.
    Unauthorized = 3,
    /// Operation requires an active stream, but the stream is inactive.
    StreamInactive = 4,
    /// `initialize` has already been called; cannot re-initialize.
    AlreadyInitialized = 5,
    /// Caller is not the protocol admin.
    NotAdmin = 6,
    /// Supplied fee rate exceeds the platform maximum (1 000 bps).
    InvalidFeeRate = 7,
    /// Protocol config has not been initialized yet.
    NotInitialized = 8,
    /// Duration supplied to `create_stream` is zero.
    InvalidDuration = 9,
    /// Supplied token address is not a valid token contract.
    InvalidTokenAddress = 10,
    /// `amount / duration` rounds to zero — the stream would lock tokens but never accrue.
    InvalidRate = 11,
    /// Operation requires an active stream, but the stream is currently paused.
    StreamPaused = 12,
    /// `resume_stream` was called on a stream that is active but not paused.
    StreamNotPaused = 13,
    /// `pause_stream` was called on a stream that is already paused.
    StreamAlreadyPaused = 14,
    /// The protocol circuit breaker is engaged; token-in operations are halted.
    ProtocolPaused = 15,
    /// A step-tranche schedule declared no steps.
    EmptyVestingSchedule = 16,
    /// A step-tranche schedule declares more than `MAX_VESTING_STEPS` steps.
    TooManyVestingSteps = 17,
    /// Step unlock times are not strictly monotonically increasing.
    NonMonotonicVestingSteps = 18,
    /// A step's `unlock_amount` is zero or negative.
    InvalidVestingStepAmount = 19,
    /// Step amounts do not sum to the stream's deposited amount.
    VestingStepTotalMismatch = 20,
    /// A vesting step unlocks at or before the stream's start time.
    VestingStepBeforeStart = 21,
    /// Cliff time is not strictly after the stream start, or the cliff amount
    /// leaves no room for the linear tail.
    InvalidCliffParameters = 22,
    /// `batch_withdraw` received more than `MAX_BATCH_WITHDRAW` stream IDs.
    BatchTooLarge = 23,
    /// Caller is not the protocol admin and not the emergency guardian, and
    /// only the admin may perform this action.
    NotGuardian = 24,
    /// `migrate` was asked to move to a version this contract cannot reach.
    UnsupportedMigration = 25,
    /// The on-chain state is already at a version newer than this contract.
    StateVersionTooNew = 26,
    /// `top_up_stream` was called on a step-tranche stream.
    ///
    /// A step schedule must sum to exactly the deposited amount, so extra
    /// tokens have nowhere to go: appending them to the final step would lock
    /// the top-up until the last milestone, and ignoring them would strand them
    /// as unclaimable residue. Rejecting is the only option that never lies to
    /// the recipient about when funds become available.
    TopUpUnsupported = 27,
    /// Rate modification attempted on unsupported schedule type.
    RateModificationUnsupported = 28,
    /// New rate is invalid (e.g., zero or too small).
    InvalidNewRate = 29,
    /// Dispute operation attempted on non-disputable stream.
    DisputeNotSupported = 30,
    /// Stream does not have an active dispute.
    NoActiveDispute = 31,
    /// Caller is not the arbiter for this stream's dispute.
    NotArbiter = 32,
    /// Allowance-based stream operation failed.
    AllowanceLocked = 33,
    /// An arithmetic operation overflowed its integer type. Specific triggers:
    /// - **Fee calculation** — `amount × fee_rate_bps` overflows `i128`.
    /// - **Withdrawal accounting** — `withdrawn_amount + claimable` overflows `i128`.
    /// - **End-time projection** — `remaining / rate` does not fit in `u64`,
    ///   or `now + seconds_remaining` overflows `u64` in `project_end_time`.
    ///
    /// Returned by: `top_up_stream`, `top_up_from`, `resume_stream`, `modify_rate`
    /// (via `project_end_time`), and any entrypoint that calls `collect_fee`
    /// or `apply_withdrawal` with an extreme token amount.
    ArithmeticOverflow = 34,
    /// `close_stream` was called on a stream that is not yet eligible for
    /// on-chain pruning: still active, not in a terminal status, or still
    /// holds unclaimed or un-refunded tokens.
    ///
    /// Returned by: `close_stream`.
    StreamStillActive = 35,
    /// `resume_stream` was called on a stream whose `is_active` flag is
    /// `false` (cancelled or fully completed). Distinct from `StreamNotPaused`,
    /// which applies to a stream that is still active but not currently paused.
    ///
    /// Returned by: `resume_stream`.
    StreamNotActive = 36,
}
