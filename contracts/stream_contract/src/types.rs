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

/// Denominator for all basis-point math (100 % = 10 000 bps).
pub const BPS_DENOMINATOR: u32 = 10_000;

/// Hard ceiling on the dynamic protocol fee: 100 bps = 1.00 %.
///
/// Kept deliberately far below [`crate::MAX_FEE_RATE_BPS`] (the legacy 10 %
/// cap) so a compromised or mistaken admin can never impose a predatory fee
/// through `configure_protocol_fees`.
pub const MAX_ALLOWED_FEE_BPS: u32 = 100;

/// Status of a payment stream.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StreamStatus {
    Active,
    Paused,
    Cancelled,
    Completed,
}

/// Dispute status for escrow-based stream cancellations.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DisputeStatus {
    None,
    Requested,
    Resolved(bool), // true = approval, false = rejection
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
    /// Dynamic, multi-recipient protocol fee configuration (singleton).
    ProtocolFeeConfig,
    /// Position receipt for a stream, keyed by stream ID and the holder's role.
    Position(u64, PositionRole),
    /// Index of position receipts owned by an address (persistent, `Vec<PositionRef>`).
    PositionOwnerIndex(Address),
}

/// Which side of a stream a [`StreamPositionMetadata`] receipt represents.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PositionRole {
    Sender,
    Recipient,
}

/// Lifecycle status of a position receipt.
///
/// A receipt is `Active` while its stream has funds outstanding, and `Settled`
/// once the stream is fully paid out (`Completed`) or cancelled. Settling burns
/// the claim entitlement while retaining the attestation for credit/payroll
/// history.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PositionStatus {
    Active,
    Settled,
}

/// Public, wallet-displayable description of a stream position receipt.
///
/// Extended to carry `owner` and `status` beyond the minimal draft shape so the
/// receipt is self-describing when returned from `get_position_metadata` and
/// `get_positions_by_owner`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamPositionMetadata {
    pub stream_id: u64,
    pub role: PositionRole,
    /// Owner of the receipt. Updated by `transfer_position` when transferable.
    pub owner: Address,
    pub token_address: Address,
    pub rate_per_second: i128,
    pub start_time: u64,
    pub end_time: u64,
    pub is_transferable: bool,
    pub status: PositionStatus,
}

/// Lightweight reference used for the per-owner position index.
///
/// Kept separate from [`StreamPositionMetadata`] so the index stays small: the
/// full metadata is loaded lazily from `DataKey::Position` only for receipts the
/// caller actually asks about.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PositionRef {
    pub stream_id: u64,
    pub role: PositionRole,
}

/// A single destination within a [`ProtocolFeeConfig`] split.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeRecipient {
    pub recipient: Address,
    /// Share of the collected fee in basis points. The split set must sum to
    /// exactly [`BPS_DENOMINATOR`] (10 000).
    pub share_bps: u32,
}

/// Dynamic protocol fee configuration with multi-recipient treasury splits.
///
/// Stored as a singleton in instance storage under `DataKey::ProtocolFeeConfig`.
/// When absent or disabled, fee collection falls back to the legacy single
/// treasury configured by `initialize`/`update_fee_config`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolFeeConfig {
    /// Total protocol fee in basis points. Capped at [`MAX_ALLOWED_FEE_BPS`].
    pub fee_bps: u32,
    /// Destinations the collected fee is split across. Sums to exactly 10 000 bps.
    pub splits: Vec<FeeRecipient>,
    /// When `false`, no fee is collected and the legacy config is bypassed.
    pub is_enabled: bool,
}

/// Immutable state of a payment stream.
///
/// Stored in persistent storage under `DataKey::Stream(id)`.
/// Space: O(1) per stream.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Stream {
    /// Address that created and funds this stream. Always set.
    pub sender: Address,
    /// Address entitled to withdraw from this stream. Always set.
    pub recipient: Address,
    /// Token being streamed. Always set.
    pub token_address: Address,
    /// Net tokens dripped per ledger-second (after fee deduction).
    ///
    /// Only meaningful for [`VestingSchedule::Linear`] and for the linear
    /// tail of [`VestingSchedule::HybridCliffLinear`]. Pure
    /// [`VestingSchedule::StepTranches`] streams store `0` here because they
    /// unlock by absolute timestamp rather than by rate; every division by
    /// this field is therefore guarded against zero.
    pub rate_per_second: i128,
    /// Net deposited amount available to the stream (after fee deduction), in stroops.
    pub deposited_amount: i128,
    /// Cumulative amount already withdrawn by the recipient, in stroops.
    pub withdrawn_amount: i128,
    /// Ledger timestamp at stream creation, in Unix epoch seconds.
    pub start_time: u64,
    /// Ledger timestamp of the last state mutation, in Unix epoch seconds.
    pub last_update_time: u64,
    /// Optional timestamp before which no tokens are claimable.
    pub cliff_time: Option<u64>,
    /// `false` once fully withdrawn or cancelled. Always set.
    pub is_active: bool,
    /// `true` while the stream is paused; accrual is frozen at `paused_at`. Always set.
    pub paused: bool,
    /// Ledger timestamp when the stream was paused (`None` if not paused), in Unix epoch seconds.
    /// Only meaningful while `paused` is true.
    pub paused_at: Option<u64>,
    /// Current status of the stream. Always set.
    pub status: StreamStatus,
    /// Unlock curve governing how this stream's tokens vest.
    pub schedule: VestingSchedule,
    /// Optional arbiter for dispute-based cancellation (for #1319).
    pub arbiter: Option<Address>,
    /// Dispute status for escrow cancellations (for #1319).
    pub dispute_status: DisputeStatus,
    /// Whether this stream uses allowance-based funding (for #1318).
    pub is_allowance_based: bool,
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

/// Pre-v3 shape of [`Stream`], which lacked the dispute/allowance fields.
///
/// Decoded by `load_stream` for records written before these features existed.
/// Upgraded records default to no arbiter, no dispute, and non-allowance-based.
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
