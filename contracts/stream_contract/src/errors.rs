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
    /// A conditional milestone id is duplicated within one stream, is
    /// referenced that does not exist, or the milestone list is empty.
    InvalidMilestone = 34,
    /// The oracle returned no price for the asset.
    OraclePriceUnavailable = 35,
    /// The oracle price is older than `ORACLE_PRICE_MAX_AGE_SECS`.
    OraclePriceStale = 36,
    /// The milestone's condition has not been met, so nothing unlocked.
    ConditionNotMet = 37,
    /// The milestone was already unlocked and cannot unlock again.
    MilestoneAlreadyUnlocked = 38,
    /// The attestation id was already used to unlock a milestone on this
    /// stream, or the attestation signer is not the milestone's oracle.
    InvalidAttestation = 39,
    /// The caller is not authorized to unlock this milestone (only the
    /// stream's sender or recipient may trigger verification).
    MilestoneCallerUnauthorized = 40,
    /// The conditional milestone list would exceed
    /// `MAX_CONDITIONAL_MILESTONES`.
    TooManyMilestones = 41,
}
