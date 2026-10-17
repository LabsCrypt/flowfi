use soroban_sdk::{contracttype, Address, BytesN, Env, Symbol};

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

/// Emitted when a sender modifies a stream's rate (for #1320).
///
/// Topic: `("stream_rate_modified", stream_id)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamRateModifiedEvent {
    pub stream_id: u64,
    pub sender: Address,
    pub old_rate_per_second: i128,
    pub new_rate_per_second: i128,
    pub new_end_time: u64,
    pub timestamp: u64,
}

/// Emitted when a cancellation dispute is initiated (for #1319).
///
/// Topic: `("dispute_requested", stream_id)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeRequestedEvent {
    pub stream_id: u64,
    pub sender: Address,
    pub arbiter: Address,
    pub timestamp: u64,
}

/// Emitted when a dispute is resolved (for #1319).
///
/// Topic: `("dispute_resolved", stream_id)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputeResolvedEvent {
    pub stream_id: u64,
    pub arbiter: Address,
    pub approved: bool,
    pub timestamp: u64,
}

/// Emitted when an allowance-based stream is created (for #1318).
///
/// Topic: `("allowance_stream_created", stream_id)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowanceStreamCreatedEvent {
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub token_address: Address,
    pub rate_per_second: i128,
    pub start_time: u64,
}

/// Emitted when a terminal (completed or cancelled) stream's storage entry is
/// pruned via `close_stream`.
///
/// Topic: `("stream_closed", stream_id)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamClosedEvent {
    pub stream_id: u64,
    /// Address that closed the stream (sender, recipient, or protocol admin).
    pub closer: Address,
    /// Ledger timestamp at which the record was pruned.
    pub timestamp: u64,
}

/// Dedicated event emitted on protocol pause toggle (#1517).
///
/// Topics: `("FlowFi", "ProtocolPaused")`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolPausedEvent {
    pub admin: Address,
    pub is_paused: bool,
}

/// Emitted when a conditional milestone's condition verifies true (#1482).
///
/// Topic: `("milestone_condition_unlocked", stream_id)`
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MilestoneConditionUnlockedEvent {
    pub stream_id: u64,
    pub milestone_id: u32,
    /// Amount that became claimable.
    pub amount: i128,
    /// Caller that triggered the verification.
    pub caller: Address,
    /// Ledger timestamp of the verification.
    pub timestamp: u64,
}

// ─── Emission Helpers ────────────────────────────────────────────────────────
//
// Every publish site in `lib.rs` routes through one of these helpers so that
// the wire format (topic tuple + payload struct) lives beside the payload
// definitions instead of being re-typed at each call site. Indexers consume
// these topics: see the backend's `soroban-event-worker.ts` decoder.

/// Emit a `stream_created` event indexed by `stream_id`.
///
/// # Event topic
/// `("stream_created", stream_id: u64)` — the `stream_id` lets indexers key
/// created streams directly from the topic without decoding the payload.
///
/// # Emission trigger
/// `create_stream`, after the deposited tokens have been transferred into the
/// contract and the post-fee `Stream` record has been persisted.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`StreamCreatedEvent`] payload: sender, recipient, net
///   `rate_per_second` and `deposited_amount` (after protocol fee), token
///   contract address, and the stream's `start_time`.
pub fn emit_stream_created(env: &Env, event: StreamCreatedEvent) {
    env.events()
        .publish((Symbol::new(env, "stream_created"), event.stream_id), event);
}

/// Emit a `stream_topped_up` event indexed by `stream_id`.
///
/// # Event topic
/// `("stream_topped_up", stream_id: u64)`.
///
/// # Emission trigger
/// `top_up_stream`, after the top-up tokens have been transferred in, the
/// protocol fee collected, and the stream record updated.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`StreamToppedUpEvent`] payload: sender, net top-up
///   `amount` (after protocol fee), the resulting total `new_deposited_amount`,
///   and the recomputed `new_end_time` at which the stream will fully drain.
pub fn emit_stream_topped_up(env: &Env, event: StreamToppedUpEvent) {
    env.events().publish(
        (Symbol::new(env, "stream_topped_up"), event.stream_id),
        event,
    );
}

/// Emit a `tokens_withdrawn` event indexed by `stream_id`.
///
/// # Event topic
/// `("tokens_withdrawn", stream_id: u64)`.
///
/// # Emission trigger
/// `withdraw` (single-stream path) and `batch_withdraw` (once per successfully
/// settled stream), after the withdrawal has been applied and persisted. When
/// the withdrawal fully drains a stream, an accompanying `stream_completed`
/// event is emitted right after this one.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`TokensWithdrawnEvent`] payload: recipient, withdrawn
///   `amount` in stroops, and the ledger `timestamp` of the settlement.
pub fn emit_tokens_withdrawn(env: &Env, event: TokensWithdrawnEvent) {
    env.events().publish(
        (Symbol::new(env, "tokens_withdrawn"), event.stream_id),
        event,
    );
}

/// Emit a `stream_cancelled` event indexed by `stream_id`.
///
/// # Event topic
/// `("stream_cancelled", stream_id: u64)`.
///
/// # Emission trigger
/// `cancel_stream`, after the recipient's accrued payout has been settled and
/// the unspent remainder refunded to the sender. Cancelling is terminal: the
/// stream status becomes `Cancelled` and can never be resumed.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`StreamCancelledEvent`] payload: sender, recipient, the
///   total `amount_withdrawn` by the recipient up to cancellation, and the
///   `refunded_amount` returned to the sender.
pub fn emit_stream_cancelled(env: &Env, event: StreamCancelledEvent) {
    env.events().publish(
        (Symbol::new(env, "stream_cancelled"), event.stream_id),
        event,
    );
}

/// Emit a `stream_completed` event indexed by `stream_id`.
///
/// # Event topic
/// `("stream_completed", stream_id: u64)`.
///
/// # Emission trigger
/// `withdraw` and `batch_withdraw`, but only on the withdrawal that fully
/// drains the stream (claimable reached zero and the status transitioned to
/// `Completed`). Emitted immediately after that withdrawal's
/// `tokens_withdrawn` event.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`StreamCompletedEvent`] payload: recipient and the
///   cumulative `total_withdrawn` over the stream's lifetime.
pub fn emit_stream_completed(env: &Env, event: StreamCompletedEvent) {
    env.events().publish(
        (Symbol::new(env, "stream_completed"), event.stream_id),
        event,
    );
}

/// Emit a `stream_closed` event indexed by `stream_id`.
///
/// # Event topic
/// `("stream_closed", stream_id: u64)`.
///
/// # Emission trigger
/// `close_stream`, after the terminal stream's storage entry has been pruned.
/// Signals the backend indexer to archive the stream locally.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`StreamClosedEvent`] payload: the `closer` (sender,
///   recipient, or protocol admin) and the ledger `timestamp` of the prune.
pub fn emit_stream_closed(env: &Env, event: StreamClosedEvent) {
    env.events()
        .publish((Symbol::new(env, "stream_closed"), event.stream_id), event);
}

/// Emit a `fee_collected` event indexed by `stream_id`.
///
/// # Event topic
/// `("fee_collected", stream_id: u64)`.
///
/// # Emission trigger
/// `collect_fee` (an internal helper) whenever a non-zero protocol fee is
/// transferred to the treasury — i.e. during `create_stream` and
/// `top_up_stream` when the fee rate is configured above zero.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`FeeCollectedEvent`] payload: treasury address, collected
///   `fee_amount` in stroops, and the token contract the fee was paid in.
pub fn emit_fee_collected(env: &Env, event: FeeCollectedEvent) {
    env.events()
        .publish((Symbol::new(env, "fee_collected"), event.stream_id), event);
}

/// Emit an `initialized` event.
///
/// # Event topic
/// `("initialized",)` — a single-symbol topic; the protocol is a singleton so
/// no secondary index is needed.
///
/// # Emission trigger
/// `initialize`, exactly once per contract deployment, after the initial
/// [`crate::types::ProtocolConfig`] and contract version have been persisted.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`InitializedEvent`] payload: initial `admin`, `treasury`,
///   and `fee_rate_bps`.
pub fn emit_initialized(env: &Env, event: InitializedEvent) {
    env.events()
        .publish((Symbol::new(env, "initialized"),), event);
}

/// Emit a `fee_config_updated` event.
///
/// # Event topic
/// `("fee_config_updated",)`.
///
/// # Emission trigger
/// `update_fee_config`, after the admin-authenticated config change has been
/// persisted. Circuit-breaker and guardian state are deliberately untouched.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`FeeConfigUpdatedEvent`] payload: acting `admin`, old and
///   new treasury addresses, and old and new fee rates in bps.
pub fn emit_fee_config_updated(env: &Env, event: FeeConfigUpdatedEvent) {
    env.events()
        .publish((Symbol::new(env, "fee_config_updated"),), event);
}

/// Emit an `admin_transferred` event.
///
/// # Event topic
/// `("admin_transferred",)`.
///
/// # Emission trigger
/// `transfer_admin`, after the new admin has been persisted. The previous
/// admin's authentication is what authorizes the call.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`AdminTransferredEvent`] payload: `previous_admin` and
///   `new_admin` addresses.
pub fn emit_admin_transferred(env: &Env, event: AdminTransferredEvent) {
    env.events()
        .publish((Symbol::new(env, "admin_transferred"),), event);
}

/// Emit a `stream_paused` event indexed by `stream_id`.
///
/// # Event topic
/// `("stream_paused", stream_id: u64)`.
///
/// # Emission trigger
/// `pause_stream`, after the stream's accrual has been frozen at `paused_at`
/// and the updated record persisted. Only the sender may pause.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`StreamPausedEvent`] payload: sender and the ledger
///   `paused_at` timestamp at which accrual was frozen.
pub fn emit_stream_paused(env: &Env, event: StreamPausedEvent) {
    env.events()
        .publish((Symbol::new(env, "stream_paused"), event.stream_id), event);
}

/// Emit a `stream_resumed` event indexed by `stream_id`.
///
/// # Event topic
/// `("stream_resumed", stream_id: u64)`.
///
/// # Emission trigger
/// `resume_stream`, after the pause interval has been accounted for, accrual
/// re-enabled and the recomputed record persisted. Only the sender may resume.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`StreamResumedEvent`] payload: sender and the recomputed
///   `new_end_time` at which the stream will now fully drain.
pub fn emit_stream_resumed(env: &Env, event: StreamResumedEvent) {
    env.events()
        .publish((Symbol::new(env, "stream_resumed"), event.stream_id), event);
}

/// Emit a `protocol_pause_status` event.
///
/// # Event topic
/// `("protocol_pause_status",)`.
///
/// # Emission trigger
/// `set_protocol_pause`, whenever the circuit breaker flips state (engaged or
/// released) — authorized by the admin or the emergency guardian.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`ProtocolPauseStatusEvent`] payload: `caller` that flipped
///   the breaker, the new `paused` state, and the ledger `timestamp` of the
///   transition.
pub fn emit_protocol_pause_status(env: &Env, event: ProtocolPauseStatusEvent) {
    env.events()
        .publish((Symbol::new(env, "protocol_pause_status"),), event);
}

/// Emits the dedicated ProtocolPaused event on pause toggle (#1517).
///
/// # Event topic
/// `("FlowFi", "ProtocolPaused")`.
///
/// # Emission trigger
/// `set_protocol_pause` / `set_emergency_pause`, whenever the circuit breaker flips state.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `admin` — caller address that triggered the pause change.
/// - `is_paused` — the new pause state.
pub fn emit_protocol_paused(env: &Env, admin: &Address, is_paused: bool) {
    env.events().publish(
        (
            Symbol::new(env, "FlowFi"),
            Symbol::new(env, "ProtocolPaused"),
        ),
        ProtocolPausedEvent {
            admin: admin.clone(),
            is_paused,
        },
    );
}

/// Emit an `emergency_guardian_updated` event.
///
/// # Event topic
/// `("emergency_guardian_updated",)`.
///
/// # Emission trigger
/// `set_emergency_guardian`, after the guardian role has been set or cleared
/// by the admin.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`EmergencyGuardianUpdatedEvent`] payload: acting `admin`
///   and the newly configured `guardian` (`None` when the role was cleared).
pub fn emit_emergency_guardian_updated(env: &Env, event: EmergencyGuardianUpdatedEvent) {
    env.events()
        .publish((Symbol::new(env, "emergency_guardian_updated"),), event);
}

/// Emit a `step_vesting_stream_created` event indexed by `stream_id`.
///
/// # Event topic
/// `("step_vesting_stream_created", stream_id: u64)`.
///
/// # Emission trigger
/// `create_step_vesting_stream`, after the deposited tokens have been
/// transferred in and the step-schedule `Stream` record persisted.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`StepVestingStreamCreatedEvent`] payload: sender,
///   recipient, token contract address, net `deposited_amount` (after
///   protocol fee), `step_count`, and the absolute `last_unlock_time` of the
///   final milestone.
pub fn emit_step_vesting_stream_created(env: &Env, event: StepVestingStreamCreatedEvent) {
    env.events().publish(
        (
            Symbol::new(env, "step_vesting_stream_created"),
            event.stream_id,
        ),
        event,
    );
}

/// Emit a `hybrid_cliff_stream_created` event indexed by `stream_id`.
///
/// # Event topic
/// `("hybrid_cliff_stream_created", stream_id: u64)`.
///
/// # Emission trigger
/// `create_hybrid_cliff_stream`, after the deposited tokens have been
/// transferred in and the cliff+linear `Stream` record persisted.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`HybridCliffStreamCreatedEvent`] payload: sender,
///   recipient, token contract address, net `deposited_amount` (after
///   protocol fee), the absolute `cliff_time`, the lump-sum
///   `cliff_unlock_amount`, and the post-cliff linear `rate_per_second`.
pub fn emit_hybrid_cliff_stream_created(env: &Env, event: HybridCliffStreamCreatedEvent) {
    env.events().publish(
        (
            Symbol::new(env, "hybrid_cliff_stream_created"),
            event.stream_id,
        ),
        event,
    );
}

/// Emit a `contract_upgraded` event.
///
/// # Event topic
/// `("contract_upgraded",)`.
///
/// # Emission trigger
/// `upgrade`, immediately before the contract's executable WASM is replaced in
/// place. Emitted *before* `update_current_contract_wasm`, so the event lands
/// in the same transaction even if the swap itself is atomic.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`ContractUpgradedEvent`] payload: acting `admin`, the
///   `old_wasm_hash` in force before the call, the `new_wasm_hash` being
///   installed, and the ledger `timestamp` of the upgrade.
pub fn emit_contract_upgraded(env: &Env, event: ContractUpgradedEvent) {
    env.events()
        .publish((Symbol::new(env, "contract_upgraded"),), event);
}

/// Emit a `state_migrated` event.
///
/// # Event topic
/// `("state_migrated",)`.
///
/// # Emission trigger
/// `migrate`, after the config and contract version have been rewritten to the
/// requested (newer) schema version. `old_version` `0` denotes unversioned,
/// pre-v1 state.
///
/// # Parameters
/// - `env` — the Soroban environment to publish into.
/// - `event` — the [`StateMigratedEvent`] payload: acting `admin` plus the
///   `old_version` and `new_version` schema versions.
pub fn emit_state_migrated(env: &Env, event: StateMigratedEvent) {
    env.events()
        .publish((Symbol::new(env, "state_migrated"),), event);
}
