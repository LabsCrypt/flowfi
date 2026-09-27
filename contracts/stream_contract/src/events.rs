use soroban_sdk::{contracttype, Address, BytesN};

// ─── Wire Format ─────────────────────────────────────────────────────────────
//
// Each event below is emitted via `env.events().publish(topics, data)`.
// `data` is the `#[contracttype]` struct serialized as a Soroban `Map`, keyed
// by field name (not positional) — so `soroban-event-worker.ts`'s `decodeMap`
// reads fields by name and is order-independent. The one invariant the
// backend decoder DOES depend on is the **field name and scalar type** of
// every field listed here; renaming or retyping a field without updating the
// matching `decode*`/`handle*` pair in `soroban-event-worker.ts` will silently
// break event processing. See `backend/tests/events-wire-format.test.ts` for
// the pinned field/type table and `test_*_emits_event` tests in `test.rs` for
// the raw topic/data capture.

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

/// Emitted when a recipient transfers stream control to a new address.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecipientTransferredEvent {
    pub stream_id: u64,
    pub old_recipient: Address,
    pub new_recipient: Address,
    pub settled_amount: i128,
    pub timestamp: u64,
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
    /// Ledger timestamp at which the stream will fully drain after this top-up, in Unix epoch seconds.
    pub new_end_time: u64,
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

/// Emitted whenever the protocol circuit breaker changes state.
///
/// Topic: `("protocol_pause_status",)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolPauseStatusEvent {
    /// The address that flipped the breaker (admin or emergency guardian).
    pub caller: Address,
    /// `true` when the protocol is now paused.
    pub paused: bool,
    /// Ledger timestamp of the transition.
    pub timestamp: u64,
}

/// Emitted when the emergency guardian role is set or cleared.
///
/// Topic: `("emergency_guardian_updated",)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmergencyGuardianUpdatedEvent {
    pub admin: Address,
    /// The newly configured guardian, or `None` when the role was cleared.
    pub guardian: Option<Address>,
}

/// Emitted when a step-tranche (milestone) stream is created.
///
/// Topic: `("step_vesting_stream_created", stream_id)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StepVestingStreamCreatedEvent {
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token_address: Address,
    /// Net deposited amount after protocol fee deduction.
    pub deposited_amount: i128,
    /// Number of unlock steps in the schedule.
    pub step_count: u32,
    /// Absolute timestamp of the final unlock step.
    pub last_unlock_time: u64,
}

/// Emitted when a hybrid cliff + linear stream is created.
///
/// Topic: `("hybrid_cliff_stream_created", stream_id)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HybridCliffStreamCreatedEvent {
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token_address: Address,
    /// Net deposited amount after protocol fee deduction.
    pub deposited_amount: i128,
    /// Absolute timestamp of the cliff unlock.
    pub cliff_time: u64,
    /// Amount released at `cliff_time`.
    pub cliff_unlock_amount: i128,
    /// Linear drip rate applied to the post-cliff remainder.
    pub rate_per_second: i128,
}

/// Emitted when the contract's executable is replaced in place.
///
/// Topic: `("contract_upgraded",)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractUpgradedEvent {
    pub admin: Address,
    /// Executable hash in force before this call.
    pub old_wasm_hash: BytesN<32>,
    /// Executable hash installed by this call.
    pub new_wasm_hash: BytesN<32>,
    /// Ledger timestamp of the upgrade.
    pub timestamp: u64,
}

/// Emitted when the on-chain state schema is migrated to a new version.
///
/// Topic: `("state_migrated",)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StateMigratedEvent {
    pub admin: Address,
    /// Schema version before the migration. `0` means unversioned (pre-v1).
    pub old_version: u32,
    /// Schema version after the migration.
    pub new_version: u32,
}
