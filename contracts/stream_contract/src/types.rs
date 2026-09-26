use soroban_sdk::{contracttype, Address, Vec};

/// Maximum number of unlock steps a single step-tranche schedule may declare.
///
/// Bounded so that a single `withdraw` can iterate the whole schedule inside
/// the Soroban CPU/memory budget regardless of how many streams are batched.
pub const MAX_VESTING_STEPS: u32 = 12;

/// Maximum number of streams a single `batch_withdraw` call may process.
///
/// Guards against blowing the transaction's CPU and memory limits; recipients
/// holding more streams than this must split their withdrawal into several
/// transactions.
pub const MAX_BATCH_WITHDRAW: u32 = 30;

/// Status of a payment stream.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StreamStatus {
    Active,
    Paused,
    Cancelled,
    Completed,
}

/// A single discrete unlock of a step-tranche (milestone) vesting schedule.
///
/// `unlock_time` is an **absolute** ledger timestamp, not an offset from the
/// stream start, so a schedule stays meaningful across pauses and resumes.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingStep {
    /// Absolute ledger timestamp at which `unlock_amount` becomes claimable.
    pub unlock_time: u64,
    /// Amount unlocked at `unlock_time`. Must be strictly positive.
    pub unlock_amount: i128,
}

/// How a stream's tokens unlock over time.
///
/// The `#[contracttype]` encoding is part of the on-chain schema: variants and
/// field names must stay stable across contract upgrades or previously written
/// `Stream` records become undecodable. See `migrate` in `lib.rs`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VestingSchedule {
    /// Continuous drip at `Stream::rate_per_second`. The original scheme.
    Linear,
    /// Milestone tranches: `unlock_amount` unlocks at each absolute
    /// `unlock_time`, with nothing unlocking in between. Step times must be
    /// strictly increasing and the amounts must sum to the deposited amount.
    StepTranches(Vec<VestingStep>),
    /// A lump-sum unlock at a cliff timestamp, after which the remainder drips
    /// linearly at `Stream::rate_per_second`.
    ///
    /// `#[contracttype]` enums cannot carry named struct-variant fields, so the
    /// two values are positional: `HybridCliffLinear(cliff_time,
    /// cliff_unlock_amount)`. Callers should use the named accessors on
    /// [`Stream`] rather than destructuring the variant.
    HybridCliffLinear(u64, i128),
}

/// Centralized storage key strategy.
///
/// All contract storage is keyed exclusively through this enum, ensuring:
/// - No ad-hoc string keys scattered through the codebase.
/// - Deterministic, collision-free key serialization via `#[contracttype]`.
/// - O(1) key construction and lookup cost.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// Global monotonic counter for assigning stream IDs.
    StreamCounter,
    /// Individual stream record, keyed by its unique u64 ID.
    Stream(u64),
    /// Protocol-level fee configuration (singleton).
    ProtocolConfig,
    /// Schema version of the persisted state layout (instance storage, u32).
    ContractVersion,
    /// Executable hash this contract was last upgraded to (instance storage).
    ///
    /// The Soroban host exposes no getter for a contract's *live* executable,
    /// so the upgrade history is tracked here instead. Absent — read as
    /// `BytesN::zero` — means the contract has never been upgraded in place.
    ContractWasmHash,
}

/// Immutable state of a payment stream.
///
/// Stored in persistent storage under `DataKey::Stream(id)`.
/// Space: O(1) per stream.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Stream {
    /// Address that created and funds this stream.
    pub sender: Address,
    /// Address entitled to withdraw from this stream.
    pub recipient: Address,
    /// Token being streamed.
    pub token_address: Address,
    /// Net tokens dripped per ledger-second (after fee deduction).
    ///
    /// Only meaningful for [`VestingSchedule::Linear`] and for the linear
    /// tail of [`VestingSchedule::HybridCliffLinear`]. Pure
    /// [`VestingSchedule::StepTranches`] streams store `0` here because they
    /// unlock by absolute timestamp rather than by rate; every division by
    /// this field is therefore guarded against zero.
    pub rate_per_second: i128,
    /// Net deposited amount available to the stream (after fee deduction).
    pub deposited_amount: i128,
    /// Cumulative amount already withdrawn by the recipient.
    pub withdrawn_amount: i128,
    /// Ledger timestamp at stream creation.
    pub start_time: u64,
    /// Ledger timestamp of the last state mutation.
    pub last_update_time: u64,
    /// `false` once fully withdrawn or cancelled.
    pub is_active: bool,
    /// `true` while the stream is paused; accrual is frozen at `paused_at`.
    pub paused: bool,
    /// Ledger timestamp when the stream was paused, `None` if not paused.
    pub paused_at: Option<u64>,
    /// Current status of the stream.
    pub status: StreamStatus,
    /// Unlock curve governing how this stream's tokens vest.
    pub schedule: VestingSchedule,
}

/// Protocol-wide configuration, fee circuit breaker and guardian role.
///
/// Stored as a singleton in instance storage under `DataKey::ProtocolConfig`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolConfig {
    /// Address with authority to update this configuration and to unpause.
    pub admin: Address,
    /// Address that receives protocol fees.
    pub treasury: Address,
    /// Fee expressed in basis points (1 bps = 0.01%). Max: 1 000 bps = 10%.
    pub fee_rate_bps: u32,
    /// Protocol-wide circuit breaker. When `true`, all token-in entrypoints
    /// (stream creation and top-up) revert with [`StreamError::ProtocolPaused`].
    ///
    /// Token-out entrypoints (`withdraw`, `batch_withdraw`, `cancel_stream`)
    /// deliberately stay open so already-vested capital can never be censored
    /// or trapped by an emergency.
    pub is_protocol_paused: bool,
    /// Optional guardian permitted to trip — but never to clear — the
    /// circuit breaker. `None` means the admin is the only authority.
    pub emergency_guardian: Option<Address>,
}

/// Pre-v2 shape of [`ProtocolConfig`], persisted by contract versions before
/// the circuit breaker existed.
///
/// Retained solely so `load_config` can still decode a configuration written
/// by an older deployment; [`crate::StreamContract::migrate`] rewrites it into
/// the current shape. Never write this type back to storage.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyProtocolConfig {
    pub admin: Address,
    pub treasury: Address,
    pub fee_rate_bps: u32,
}

/// Pre-v2 shape of [`Stream`], which lacked the `schedule` discriminator.
///
/// Decoded by `load_stream` for records written before step vesting existed; a
/// legacy stream is by definition a continuous drip, so the upgraded record gets
/// [`VestingSchedule::Linear`]. See [`crate::StreamContract::migrate`] for why
/// migration happens lazily instead of in bulk.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LegacyStream {
    pub sender: Address,
    pub recipient: Address,
    pub token_address: Address,
    pub rate_per_second: i128,
    pub deposited_amount: i128,
    pub withdrawn_amount: i128,
    pub start_time: u64,
    pub last_update_time: u64,
    pub is_active: bool,
    pub paused: bool,
    pub paused_at: Option<u64>,
    pub status: StreamStatus,
}
