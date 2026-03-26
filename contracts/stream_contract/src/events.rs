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
