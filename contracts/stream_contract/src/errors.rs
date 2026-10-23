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
    /// A checked arithmetic operation on an amount or timestamp would have
    /// exceeded its representable range.
    ///
    /// The five call sites that raise this guard a `checked_*` operation
    /// *before* any state mutation or token transfer, so returning here always
    /// leaves the stream untouched. The variant is appended rather than slotted
    /// into the sequence so that existing discriminants 1..=33 — and therefore
    /// every error already observable by clients — keep their meaning.
    ArithmeticOverflow = 34,
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
    /// Protocol fee exceeds the maximum allowed cap (max 100 bps / 1%).
    FeeExceedsMaximum = 45,
    /// The sum of recipient shares in a fee split does not equal 10_000 bps.
    InvalidFeeSplit = 46,
    /// The deadline has expired for a cross-asset withdrawal.
    DeadlineExpired = 47,
    /// The DEX swap returned less than the caller's minimum output amount.
    InsufficientOutput = 48,
}

/// Type alias mapping `ContractError` to `StreamError` for off-chain testing and SDK callers.
pub type ContractError = StreamError;

impl StreamError {
    /// Alias for `InvalidDuration` representing an invalid time range (e.g. end_time <= start_time or zero duration).
    #[allow(non_upper_case_globals)]
    pub const InvalidTimeRange: StreamError = StreamError::InvalidDuration;

    /// Returns the unique numeric `u32` code associated with this error variant.
    #[inline]
    pub const fn code(self) -> u32 {
        self as u32
    }
}

impl TryFrom<u32> for StreamError {
    type Error = ();

    #[inline]
    fn try_from(code: u32) -> Result<Self, Self::Error> {
        match code {
            1 => Ok(StreamError::InvalidAmount),
            2 => Ok(StreamError::StreamNotFound),
            3 => Ok(StreamError::Unauthorized),
            4 => Ok(StreamError::StreamInactive),
            5 => Ok(StreamError::AlreadyInitialized),
            6 => Ok(StreamError::NotAdmin),
            7 => Ok(StreamError::InvalidFeeRate),
            8 => Ok(StreamError::NotInitialized),
            9 => Ok(StreamError::InvalidDuration),
            10 => Ok(StreamError::InvalidTokenAddress),
            11 => Ok(StreamError::InvalidRate),
            12 => Ok(StreamError::StreamPaused),
            13 => Ok(StreamError::StreamNotPaused),
            14 => Ok(StreamError::StreamAlreadyPaused),
            15 => Ok(StreamError::ProtocolPaused),
            16 => Ok(StreamError::EmptyVestingSchedule),
            17 => Ok(StreamError::TooManyVestingSteps),
            18 => Ok(StreamError::NonMonotonicVestingSteps),
            19 => Ok(StreamError::InvalidVestingStepAmount),
            20 => Ok(StreamError::VestingStepTotalMismatch),
            21 => Ok(StreamError::VestingStepBeforeStart),
            22 => Ok(StreamError::InvalidCliffParameters),
            23 => Ok(StreamError::BatchTooLarge),
            24 => Ok(StreamError::NotGuardian),
            25 => Ok(StreamError::UnsupportedMigration),
            26 => Ok(StreamError::StateVersionTooNew),
            27 => Ok(StreamError::TopUpUnsupported),
            28 => Ok(StreamError::RateModificationUnsupported),
            29 => Ok(StreamError::InvalidNewRate),
            30 => Ok(StreamError::DisputeNotSupported),
            31 => Ok(StreamError::NoActiveDispute),
            32 => Ok(StreamError::NotArbiter),
            33 => Ok(StreamError::AllowanceLocked),
            34 => Ok(StreamError::ArithmeticOverflow),
            35 => Ok(StreamError::StreamNotActive),
            36 => Ok(StreamError::StreamStillActive),
            37 => Ok(StreamError::InvalidMilestone),
            38 => Ok(StreamError::OraclePriceUnavailable),
            39 => Ok(StreamError::OraclePriceStale),
            40 => Ok(StreamError::ConditionNotMet),
            41 => Ok(StreamError::MilestoneAlreadyUnlocked),
            42 => Ok(StreamError::InvalidAttestation),
            43 => Ok(StreamError::MilestoneCallerUnauthorized),
            44 => Ok(StreamError::TooManyMilestones),
            45 => Ok(StreamError::FeeExceedsMaximum),
            46 => Ok(StreamError::InvalidFeeSplit),
            47 => Ok(StreamError::DeadlineExpired),
            48 => Ok(StreamError::InsufficientOutput),
            _ => Err(()),
        }
    }
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

    use super::{ContractError, StreamError};
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
                StreamError::FeeExceedsMaximum => "FeeExceedsMaximum",
                StreamError::InvalidFeeSplit => "InvalidFeeSplit",
                StreamError::DeadlineExpired => "DeadlineExpired",
                StreamError::InsufficientOutput => "InsufficientOutput",
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
        const ALL_VARIANTS: [(StreamError, &str, u32); 48] = [
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
            (
                StreamError::RateModificationUnsupported,
                "RateModificationUnsupported",
                28,
            ),
            (StreamError::InvalidNewRate, "InvalidNewRate", 29),
            (StreamError::DisputeNotSupported, "DisputeNotSupported", 30),
            (StreamError::NoActiveDispute, "NoActiveDispute", 31),
            (StreamError::NotArbiter, "NotArbiter", 32),
            (StreamError::AllowanceLocked, "AllowanceLocked", 33),
            (StreamError::ArithmeticOverflow, "ArithmeticOverflow", 34),
            (StreamError::StreamNotActive, "StreamNotActive", 35),
            (StreamError::StreamStillActive, "StreamStillActive", 36),
            (StreamError::InvalidMilestone, "InvalidMilestone", 37),
            (
                StreamError::OraclePriceUnavailable,
                "OraclePriceUnavailable",
                38,
            ),
            (StreamError::OraclePriceStale, "OraclePriceStale", 39),
            (StreamError::ConditionNotMet, "ConditionNotMet", 40),
            (
                StreamError::MilestoneAlreadyUnlocked,
                "MilestoneAlreadyUnlocked",
                41,
            ),
            (StreamError::InvalidAttestation, "InvalidAttestation", 42),
            (
                StreamError::MilestoneCallerUnauthorized,
                "MilestoneCallerUnauthorized",
                43,
            ),
            (StreamError::TooManyMilestones, "TooManyMilestones", 44),
            (StreamError::FeeExceedsMaximum, "FeeExceedsMaximum", 45),
            (StreamError::InvalidFeeSplit, "InvalidFeeSplit", 46),
            (StreamError::DeadlineExpired, "DeadlineExpired", 47),
            (StreamError::InsufficientOutput, "InsufficientOutput", 48),
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
        fn test_contract_error_round_trip_and_code() {
            for (variant, _, code) in ALL_VARIANTS {
                // Verify .code() returns the documented discriminant
                assert_eq!(variant.code(), code);

                // Verify ContractError::try_from(u32) returns Ok(variant)
                let from_code = ContractError::try_from(code);
                assert_eq!(from_code, Ok(variant));

                // Verify round trip: try_from(variant.code()) == Ok(variant)
                assert_eq!(ContractError::try_from(variant.code()), Ok(variant));
            }

            // Unknown error codes must return Err(())
            assert_eq!(ContractError::try_from(0), Err(()));
            assert_eq!(ContractError::try_from(49), Err(()));
            assert_eq!(ContractError::try_from(100), Err(()));
            assert_eq!(ContractError::try_from(u32::MAX), Err(()));
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
