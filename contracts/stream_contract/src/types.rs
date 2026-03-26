#![allow(unused)]

use soroban_sdk::{contracttype, Address};

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
    /// Address that created and funds this stream.
    pub sender: Address,
    /// Address entitled to withdraw from this stream.
    pub recipient: Address,
    /// Token being streamed.
    pub token_address: Address,
    /// Net tokens dripped per ledger-second (after fee deduction).
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
