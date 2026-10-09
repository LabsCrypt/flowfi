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
    /// A checked arithmetic operation overflowed the `i128` or `u64` range.
    ///
    /// Raised by the `checked_*` helpers that guard accrual projection, fee
    /// collection and withdrawal bookkeeping, so an out-of-range amount is
    /// reported instead of silently wrapping or aborting the invocation.
    ArithmeticOverflow = 34,
    /// `resume_stream` was called on a stream that is no longer active.
    StreamNotActive = 35,
    /// `close_stream` was called on a stream that is still active or still
    /// holds unwithdrawn funds, so its record cannot be pruned yet.
    StreamStillActive = 36,
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
    InvalidMilestone = 37,
    /// The oracle returned no price for the asset.
    OraclePriceUnavailable = 38,
    /// The oracle price is older than `ORACLE_PRICE_MAX_AGE_SECS`.
    OraclePriceStale = 39,
    /// The milestone's condition has not been met, so nothing unlocked.
    ConditionNotMet = 40,
    /// The milestone was already unlocked and cannot unlock again.
    MilestoneAlreadyUnlocked = 41,
    /// The attestation id was already used to unlock a milestone on this
    /// stream, or the attestation signer is not the milestone's oracle.
    InvalidAttestation = 42,
    /// The caller is not authorized to unlock this milestone (only the
    /// stream's sender or recipient may trigger verification).
    MilestoneCallerUnauthorized = 43,
    /// The conditional milestone list would exceed
    /// `MAX_CONDITIONAL_MILESTONES`.
    TooManyMilestones = 44,
}

impl StreamError {
    /// Alias for `InvalidDuration` representing an invalid time range (e.g. end_time <= start_time or zero duration).
    #[allow(non_upper_case_globals)]
    pub const InvalidTimeRange: StreamError = StreamError::InvalidDuration;
}

// ─── Test diagnostics (compiled only under `cfg(test)`) ───────────────────
//
// Soroban surfaces contract errors to test assertions as raw numeric codes
// (e.g. `Error(Contract, #4)`), so a failing assertion forces developers to
// cross-reference this file by hand to map the integer back to a variant name.
// The `Display` impl and `describe_actual` helper below print the variant name
// alongside the numeric code, making test failures self-describing.
//
// Everything in this module is gated behind `#[cfg(test)]`: it never compiles
// into the release/WASM binary, so contract size is unaffected.
#[cfg(test)]
pub(crate) mod test_diagnostics {
    extern crate std;

    use super::StreamError;
    use core::fmt;

    impl StreamError {
        /// Human-readable variant name, for test diagnostics only.
        pub const fn name(self) -> &'static str {
            match self {
                StreamError::InvalidAmount => "InvalidAmount",
                StreamError::StreamNotFound => "StreamNotFound",
                StreamError::Unauthorized => "Unauthorized",
                StreamError::StreamInactive => "StreamInactive",
                StreamError::AlreadyInitialized => "AlreadyInitialized",
                StreamError::NotAdmin => "NotAdmin",
                StreamError::InvalidFeeRate => "InvalidFeeRate",
                StreamError::NotInitialized => "NotInitialized",
                StreamError::InvalidDuration => "InvalidDuration",
                StreamError::InvalidTokenAddress => "InvalidTokenAddress",
                StreamError::InvalidRate => "InvalidRate",
                StreamError::StreamPaused => "StreamPaused",
                StreamError::StreamNotPaused => "StreamNotPaused",
                StreamError::StreamAlreadyPaused => "StreamAlreadyPaused",
                StreamError::ProtocolPaused => "ProtocolPaused",
                StreamError::EmptyVestingSchedule => "EmptyVestingSchedule",
                StreamError::TooManyVestingSteps => "TooManyVestingSteps",
                StreamError::NonMonotonicVestingSteps => "NonMonotonicVestingSteps",
                StreamError::InvalidVestingStepAmount => "InvalidVestingStepAmount",
                StreamError::VestingStepTotalMismatch => "VestingStepTotalMismatch",
                StreamError::VestingStepBeforeStart => "VestingStepBeforeStart",
                StreamError::InvalidCliffParameters => "InvalidCliffParameters",
                StreamError::BatchTooLarge => "BatchTooLarge",
                StreamError::NotGuardian => "NotGuardian",
                StreamError::UnsupportedMigration => "UnsupportedMigration",
                StreamError::StateVersionTooNew => "StateVersionTooNew",
                StreamError::TopUpUnsupported => "TopUpUnsupported",
                StreamError::RateModificationUnsupported => "RateModificationUnsupported",
                StreamError::InvalidNewRate => "InvalidNewRate",
                StreamError::DisputeNotSupported => "DisputeNotSupported",
                StreamError::NoActiveDispute => "NoActiveDispute",
                StreamError::NotArbiter => "NotArbiter",
                StreamError::AllowanceLocked => "AllowanceLocked",
                StreamError::ArithmeticOverflow => "ArithmeticOverflow",
                StreamError::StreamStillActive => "StreamStillActive",
                StreamError::StreamNotActive => "StreamNotActive",
                StreamError::InvalidMilestone => "InvalidMilestone",
                StreamError::OraclePriceUnavailable => "OraclePriceUnavailable",
                StreamError::OraclePriceStale => "OraclePriceStale",
                StreamError::ConditionNotMet => "ConditionNotMet",
                StreamError::MilestoneAlreadyUnlocked => "MilestoneAlreadyUnlocked",
                StreamError::InvalidAttestation => "InvalidAttestation",
                StreamError::MilestoneCallerUnauthorized => "MilestoneCallerUnauthorized",
                StreamError::TooManyMilestones => "TooManyMilestones",
            }
        }
    }

    impl fmt::Display for StreamError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(f, "{} (code {})", self.name(), *self as u32)
        }
    }

    /// Describes the actual outcome of a `try_*` invocation for assertion
    /// failure messages, naming the variant when it is a `StreamError`.
    pub fn describe_actual<T>(
        result: &Result<Result<T, StreamError>, Result<StreamError, u32>>,
    ) -> std::string::String
    where
        T: fmt::Debug,
    {
        match result {
            Ok(value) => std::format!("the call unexpectedly succeeded with {:?}", value),
            Err(Ok(actual)) => std::format!("{}", actual),
            Err(Err(other)) => std::format!("a non-contract error {:?}", other),
        }
    }

    /// Asserts that a `try_*` invocation failed with the expected
    /// [`StreamError`] variant.
    ///
    /// On failure the message prints the expected variant name, a
    /// human-readable description of the actual outcome (variant name plus
    /// numeric code for contract errors), and the caller's context — so
    /// Soroban's raw `Error(Contract, #4)` output no longer has to be decoded
    /// by hand against this file.
    ///
    /// ```ignore
    /// let result = client.try_withdraw(&attacker, &id);
    /// assert_stream_error!(result, StreamError::Unauthorized, "only recipient may withdraw");
    /// ```
    macro_rules! assert_stream_error {
        ($result:expr, $expected:expr) => {
            assert_stream_error!($result, $expected, "contract error mismatch")
        };
        ($result:expr, $expected:expr, $msg:expr) => {{
            let result = $result;
            let expected: StreamError = $expected;
            let matches = match &result {
                Err(Ok(actual)) => *actual == expected,
                _ => false,
            };
            let actual_description = match &result {
                Err(Ok(actual)) => std::format!("{}", actual),
                Err(Err(other)) => std::format!("a non-contract error {:?}", other),
                Ok(value) => std::format!("the call unexpectedly succeeded with {:?}", value),
            };
            assert!(
                matches,
                "{}: expected {} but got {}",
                $msg, expected, actual_description
            );
        }};
    }
    pub(crate) use assert_stream_error;

    #[cfg(test)]
    mod tests {
        extern crate std;

        use super::*;
        use std::string::ToString;

        /// (variant, identifier, documented numeric code) for every variant.
        const ALL_VARIANTS: [(StreamError, &str, u32); 27] = [
            (StreamError::InvalidAmount, "InvalidAmount", 1),
            (StreamError::StreamNotFound, "StreamNotFound", 2),
            (StreamError::Unauthorized, "Unauthorized", 3),
            (StreamError::StreamInactive, "StreamInactive", 4),
            (StreamError::AlreadyInitialized, "AlreadyInitialized", 5),
            (StreamError::NotAdmin, "NotAdmin", 6),
            (StreamError::InvalidFeeRate, "InvalidFeeRate", 7),
            (StreamError::NotInitialized, "NotInitialized", 8),
            (StreamError::InvalidDuration, "InvalidDuration", 9),
            (StreamError::InvalidTokenAddress, "InvalidTokenAddress", 10),
            (StreamError::InvalidRate, "InvalidRate", 11),
            (StreamError::StreamPaused, "StreamPaused", 12),
            (StreamError::StreamNotPaused, "StreamNotPaused", 13),
            (StreamError::StreamAlreadyPaused, "StreamAlreadyPaused", 14),
            (StreamError::ProtocolPaused, "ProtocolPaused", 15),
            (
                StreamError::EmptyVestingSchedule,
                "EmptyVestingSchedule",
                16,
            ),
            (StreamError::TooManyVestingSteps, "TooManyVestingSteps", 17),
            (
                StreamError::NonMonotonicVestingSteps,
                "NonMonotonicVestingSteps",
                18,
            ),
            (
                StreamError::InvalidVestingStepAmount,
                "InvalidVestingStepAmount",
                19,
            ),
            (
                StreamError::VestingStepTotalMismatch,
                "VestingStepTotalMismatch",
                20,
            ),
            (
                StreamError::VestingStepBeforeStart,
                "VestingStepBeforeStart",
                21,
            ),
            (
                StreamError::InvalidCliffParameters,
                "InvalidCliffParameters",
                22,
            ),
            (StreamError::BatchTooLarge, "BatchTooLarge", 23),
            (StreamError::NotGuardian, "NotGuardian", 24),
            (
                StreamError::UnsupportedMigration,
                "UnsupportedMigration",
                25,
            ),
            (StreamError::StateVersionTooNew, "StateVersionTooNew", 26),
            (StreamError::TopUpUnsupported, "TopUpUnsupported", 27),
        ];

        #[test]
        fn name_returns_the_variant_identifier_for_every_variant() {
            for (variant, name, _) in ALL_VARIANTS {
                assert_eq!(variant.name(), name);
            }
        }

        #[test]
        fn numeric_codes_match_the_documented_discriminants() {
            for (variant, _, code) in ALL_VARIANTS {
                assert_eq!(variant as u32, code);
            }
        }

        #[test]
        fn display_prints_the_variant_name_alongside_the_numeric_code() {
            assert_eq!(
                StreamError::StreamInactive.to_string(),
                "StreamInactive (code 4)"
            );
            assert_eq!(
                StreamError::Unauthorized.to_string(),
                "Unauthorized (code 3)"
            );
        }

        #[test]
        fn describe_actual_names_contract_errors() {
            // Mirrors the concrete shape of the generated `try_*` client
            // methods: `Result<Result<T, StreamError>, Result<StreamError, _>>`.
            let result: Result<Result<(), StreamError>, Result<StreamError, u32>> =
                Err(Ok(StreamError::StreamPaused));
            assert_eq!(describe_actual(&result), "StreamPaused (code 12)");
        }

        #[test]
        fn describe_actual_reports_unexpected_success() {
            let result: Result<Result<(), StreamError>, Result<StreamError, u32>> = Ok(Ok(()));
            assert_eq!(
                describe_actual(&result),
                "the call unexpectedly succeeded with Ok(())"
            );
        }
    }
}
