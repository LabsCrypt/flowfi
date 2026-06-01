use soroban_sdk::{contracttype, Address};

/// Emitted when a new stream is created.
///
/// Topic: `("stream_created", stream_id)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCreatedEvent {
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
    /// Net rate per second after protocol fee deduction.
    pub rate_per_second: i128,
    pub token_address: Address,
    /// Net deposited amount after protocol fee deduction.
    pub deposited_amount: i128,
    pub start_time: u64,
}

/// Emitted when a sender tops up an active stream.
///
/// Topic: `("stream_topped_up", stream_id)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamToppedUpEvent {
    pub stream_id: u64,
    pub sender: Address,
    /// Net top-up amount credited to the stream (after protocol fee).
    pub amount: i128,
    /// Total deposited amount on the stream after this top-up.
    pub new_deposited_amount: i128,
}

/// Emitted when the recipient withdraws accrued tokens.
///
/// Topic: `("tokens_withdrawn", stream_id)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokensWithdrawnEvent {
    pub stream_id: u64,
    pub recipient: Address,
    pub amount: i128,
    pub timestamp: u64,
}

/// Emitted when a sender cancels an active stream.
///
/// Topic: `("stream_cancelled", stream_id)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCancelledEvent {
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
    /// Total amount withdrawn by the recipient up to cancellation.
    pub amount_withdrawn: i128,
    /// Unspent amount (deposited - withdrawn) returned to sender.
    pub refunded_amount: i128,
}

/// Emitted when a protocol fee is collected during create or top-up.
///
/// Topic: `("fee_collected", stream_id)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeCollectedEvent {
    pub stream_id: u64,
    pub treasury: Address,
    pub fee_amount: i128,
    pub token: Address,
}

/// Emitted once during one-time protocol initialization.
///
/// Topic: `("initialized",)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InitializedEvent {
    pub admin: Address,
    pub treasury: Address,
    pub fee_rate_bps: u32,
}

/// Emitted when the fee configuration (treasury address or fee rate) is updated.
///
/// Topic: `("fee_config_updated",)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeConfigUpdatedEvent {
    pub admin: Address,
    pub old_treasury: Address,
    pub new_treasury: Address,
    pub old_fee_rate_bps: u32,
    pub new_fee_rate_bps: u32,
}

/// Emitted when the protocol admin is transferred to a new address.
///
/// Topic: `("admin_transferred",)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminTransferredEvent {
    /// The previous admin address that initiated the transfer.
    pub previous_admin: Address,
    /// The new admin address that now controls the protocol.
    pub new_admin: Address,
}

/// Emitted when a sender pauses an active stream.
///
/// Topic: `("stream_paused", stream_id)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamPausedEvent {
    pub stream_id: u64,
    pub sender: Address,
    /// Ledger timestamp at which accrual was frozen.
    pub paused_at: u64,
}

/// Emitted when a sender resumes a paused stream.
///
/// Topic: `("stream_resumed", stream_id)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamResumedEvent {
    pub stream_id: u64,
    pub sender: Address,
    /// Recomputed ledger timestamp at which the stream will fully drain.
    pub new_end_time: u64,
}

/// Emitted when a stream is fully drained on the final withdrawal.
///
/// Topic: `("stream_completed", stream_id)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCompletedEvent {
    pub stream_id: u64,
    pub recipient: Address,
    pub total_withdrawn: i128,
}
