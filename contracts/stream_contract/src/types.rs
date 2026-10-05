use soroban_sdk::{contracttype, Address};

/// Status of a payment stream.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StreamStatus {
    Active,
    Paused,
    Cancelled,
    Completed,
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
    /// Net tokens dripped per second (after fee deduction), in stroops.
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
}

/// Input for atomic batch stream creation.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchStreamInput {
    pub recipient: Address,
    pub token_address: Address,
    pub amount: i128,
    pub duration: u64,
    pub cliff_duration: Option<u64>,
}

/// Protocol-wide fee configuration.
///
/// Stored as a singleton in instance storage under `DataKey::ProtocolConfig`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolConfig {
    /// Address with authority to update this configuration.
    pub admin: Address,
    /// Address that receives protocol fees.
    pub treasury: Address,
    /// Fee expressed in basis points (1 bps = 0.01%). Max: 1 000 bps = 10%.
    pub fee_rate_bps: u32,
}
