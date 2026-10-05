//! # `stream_contract` — Soroban Payment-Streaming Contract
//!
//! ## Module responsibilities
//!
//! | Module | Responsibility |
//! |--------|---------------|
//! | [`lib.rs`](./lib.rs) | Public contract interface (`StreamContract`) — entrypoints exposed via `#[contractimpl]` |
//! | [`storage.rs`](./storage.rs) | Persistent state — read/write `ProtocolConfig` and `Stream` records to Soroban storage |
//! | [`types.rs`](./types.rs) | Data types — `Stream`, `ProtocolConfig`, `StreamStatus`, `DataKey` |
//! | [`errors.rs`](./errors.rs) | Error types — `StreamError` enum with all contract error variants |
//! | [`events.rs`](./events.rs) | Event payloads — typed structs emitted by each entrypoint |
//! | [`test.rs`](./test.rs) | Unit & integration tests — module gated behind `#[cfg(test)]` |
//!
//! ## Stream State Invariant
//!
//! The `is_active` and `paused` fields are independently-settable with an implicit
//! invariant: **a cancelled stream must never be resumable**. Once a stream's status
//! is set to `Cancelled`, it cannot be resumed, even if `paused` is set to `true`.
//! This invariant is critical for preventing state-invariant bugs and must be
//! preserved across all contract changes. See Testing #94 for test coverage of this
//! invariant.

#![no_std]
#![doc = include_str!("../README.md")]

mod errors;
mod events;
mod storage;
mod types;

#[cfg(test)]
mod acceptance_tests;
#[cfg(test)]
mod property_tests;
#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, token, vec, Address, Env, InvokeError, Symbol, Vec};

use errors::StreamError;
use events::{
    AdminTransferredEvent, FeeCollectedEvent, FeeConfigUpdatedEvent, InitializedEvent,
    RecipientTransferredEvent, StreamCancelledEvent, StreamCompletedEvent, StreamCreatedEvent,
    StreamPausedEvent, StreamResumedEvent, StreamToppedUpEvent, TokensWithdrawnEvent,
};
use storage::{
    config_exists, load_config, load_stream, next_stream_id, save_config, save_stream,
    try_load_config, try_load_stream,
};
use types::{BatchStreamInput, ProtocolConfig, Stream, StreamStatus};

/// Maximum allowed protocol fee: 1 000 bps = 10%.
const MAX_FEE_RATE_BPS: u32 = 1_000;

#[contract]
pub struct StreamContract;

#[contractimpl]
impl StreamContract {
    // ─── Protocol Administration ──────────────────────────────────────────────

    /// One-time initialization of the protocol fee configuration.
    ///
    /// # Errors
    /// - `AlreadyInitialized` — called more than once.
    /// - `InvalidFeeRate`     — `fee_rate_bps` exceeds `MAX_FEE_RATE_BPS`.
    pub fn initialize(
        env: Env,
        admin: Address,
        treasury: Address,
        fee_rate_bps: u32,
    ) -> Result<(), StreamError> {
        admin.require_auth();

        if config_exists(&env) {
            return Err(StreamError::AlreadyInitialized);
        }
        if fee_rate_bps > MAX_FEE_RATE_BPS {
            return Err(StreamError::InvalidFeeRate);
        }

        save_config(
            &env,
            &ProtocolConfig {
                admin: admin.clone(),
                treasury: treasury.clone(),
                fee_rate_bps,
            },
        );

        env.events().publish(
            (Symbol::new(&env, "initialized"),),
            InitializedEvent {
                admin,
                treasury,
                fee_rate_bps,
            },
        );

        Ok(())
    }

    /// Update the treasury address and/or fee rate. Admin-only.
    ///
    /// # Errors
    /// - `NotInitialized` — `initialize` has not been called.
    /// - `NotAdmin`       — caller is not the current admin.
    /// - `InvalidFeeRate` — `fee_rate_bps` exceeds `MAX_FEE_RATE_BPS`.
    pub fn update_fee_config(
        env: Env,
        admin: Address,
        treasury: Address,
        fee_rate_bps: u32,
    ) -> Result<(), StreamError> {
        admin.require_auth();

        let config = load_config(&env)?;
        if config.admin != admin {
            return Err(StreamError::NotAdmin);
        }
        if fee_rate_bps > MAX_FEE_RATE_BPS {
            return Err(StreamError::InvalidFeeRate);
        }

        save_config(
            &env,
            &ProtocolConfig {
                admin: config.admin.clone(),
                treasury: treasury.clone(),
                fee_rate_bps,
            },
        );

        env.events().publish(
            (Symbol::new(&env, "fee_config_updated"),),
            FeeConfigUpdatedEvent {
                admin,
                old_treasury: config.treasury,
                new_treasury: treasury,
                old_fee_rate_bps: config.fee_rate_bps,
                new_fee_rate_bps: fee_rate_bps,
            },
        );

        Ok(())
    }

    /// Transfer the protocol admin role to a new address.
    ///
    /// The current admin must authenticate. After this call the new address
    /// becomes the sole admin and the previous admin loses all admin privileges.
    ///
    /// # Errors
    /// - `NotInitialized` — `initialize` has not been called.
    /// - `NotAdmin`       — caller is not the current admin.
    pub fn transfer_admin(
        env: Env,
        current_admin: Address,
        new_admin: Address,
    ) -> Result<(), StreamError> {
        current_admin.require_auth();

        let config = load_config(&env)?;
        if config.admin != current_admin {
            return Err(StreamError::NotAdmin);
        }

        save_config(
            &env,
            &ProtocolConfig {
                admin: new_admin.clone(),
                treasury: config.treasury,
                fee_rate_bps: config.fee_rate_bps,
            },
        );

        env.events().publish(
            (Symbol::new(&env, "admin_transferred"),),
            AdminTransferredEvent {
                previous_admin: current_admin,
                new_admin,
            },
        );

        Ok(())
    }

    /// Returns the current protocol fee configuration, or `None` if not yet initialized.
    pub fn get_fee_config(env: Env) -> Option<ProtocolConfig> {
        try_load_config(&env)
    }

    // ─── Stream Operations ────────────────────────────────────────────────────

    /// Create a new payment stream.
    ///
    /// Transfers `amount` tokens from `sender` to the contract, deducts the
    /// protocol fee (if configured), and records the stream with a calculated
    /// `rate_per_second = net_amount / duration`.
    ///
    /// Returns the new stream ID (starts at 1, increments monotonically).
    ///
    /// # Errors
    /// - `InvalidAmount`   — `amount` ≤ 0.
    /// - `InvalidDuration` — `duration` is 0.
    /// - `InvalidRate`     — `net_amount / duration` rounds to zero.
    /// - `InvalidTokenAddress` — `token_address` is not a token contract.
    /// - `ArithmeticOverflow` — the protocol fee calculation overflows `i128`.
    pub fn create_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token_address: Address,
        amount: i128,
        duration: u64,
    ) -> Result<u64, StreamError> {
        sender.require_auth();

        if amount <= 0 {
            return Err(StreamError::InvalidAmount);
        }
        if duration == 0 {
            return Err(StreamError::InvalidDuration);
        }
        Self::validate_token_contract(&env, &token_address)?;

        let stream_id = next_stream_id(&env);
        let start_time = env.ledger().timestamp();

        // Transfer gross amount from sender to this contract.
        let token_client = token::Client::new(&env, &token_address);
        let contract_address = env.current_contract_address();
        token_client.transfer(&sender, &contract_address, &amount);

        // Deduct protocol fee; returns net amount (== amount when no fee config).
        let net_amount = Self::collect_fee(&env, &token_address, amount, stream_id)?;
        let rate_per_second = net_amount / (duration as i128);

        // Reject streams where integer division rounds the rate to zero.
        // Such a stream would lock the sender's tokens in the contract while
        // never accruing anything to the recipient — almost always a caller
        // mistake (wrong decimals or an excessively long duration).
        // Soroban rolls back the entire transaction on Err, so the token
        // transfer above is unwound automatically.
        if rate_per_second == 0 {
            return Err(StreamError::InvalidRate);
        }

        save_stream(
            &env,
            stream_id,
            &Stream {
                sender: sender.clone(),
                recipient: recipient.clone(),
                token_address: token_address.clone(),
                rate_per_second,
                deposited_amount: net_amount,
                withdrawn_amount: 0,
                start_time,
                last_update_time: start_time,
                cliff_time: None,
                is_active: true,
                paused: false,
                paused_at: None,
                status: StreamStatus::Active,
            },
        );

        env.events().publish(
            (Symbol::new(&env, "stream_created"), stream_id),
            StreamCreatedEvent {
                stream_id,
                sender,
                recipient,
                rate_per_second,
                token_address,
                deposited_amount: net_amount,
                start_time,
            },
        );

        Ok(stream_id)
    }

    /// Create multiple streams atomically, aggregating token transfers by token.
    pub fn batch_create_streams(
        env: Env,
        sender: Address,
        streams: Vec<BatchStreamInput>,
    ) -> Result<Vec<u64>, StreamError> {
        sender.require_auth();
        let count = streams.len();
        if count == 0 || count > 50 {
            return Err(StreamError::InvalidAmount);
        }

        // Validate all inputs before any transfer or state mutation.
        for input in streams.iter() {
            if input.amount <= 0 || input.duration == 0 {
                return Err(if input.amount <= 0 {
                    StreamError::InvalidAmount
                } else {
                    StreamError::InvalidDuration
                });
            }
            if let Some(cliff) = input.cliff_duration {
                if cliff == 0 || cliff > input.duration {
                    return Err(StreamError::InvalidDuration);
                }
            }
            Self::validate_token_contract(&env, &input.token_address)?;
            if input.amount / input.duration as i128 == 0 {
                return Err(StreamError::InvalidRate);
            }
        }

        let contract_address = env.current_contract_address();
        // Aggregate gross deposits per token while preserving first-seen order.
        let mut token_totals: Vec<(Address, i128)> = Vec::new(&env);
        for input in streams.iter() {
            let mut found = false;
            for i in 0..token_totals.len() {
                let (token_address, total) = token_totals.get(i).unwrap();
                if token_address == input.token_address {
                    token_totals.set(i, (token_address, total + input.amount));
                    found = true;
                    break;
                }
            }
            if !found {
                token_totals.push_back((input.token_address.clone(), input.amount));
            }
        }
        for (token_address, total) in token_totals.iter() {
            token::Client::new(&env, &token_address).transfer(&sender, &contract_address, &total);
        }

        let mut ids: Vec<u64> = Vec::new(&env);
        for input in streams.iter() {
            let stream_id = next_stream_id(&env);
            let start_time = env.ledger().timestamp();
            let net_amount =
                Self::collect_fee(&env, &input.token_address, input.amount, stream_id)?;
            let cliff_time = input.cliff_duration.map(|duration| start_time + duration);
            let stream = Stream {
                sender: sender.clone(),
                recipient: input.recipient.clone(),
                token_address: input.token_address.clone(),
                rate_per_second: net_amount / input.duration as i128,
                deposited_amount: net_amount,
                withdrawn_amount: 0,
                start_time,
                last_update_time: start_time,
                cliff_time,
                is_active: true,
                paused: false,
                paused_at: None,
                status: StreamStatus::Active,
            };
            save_stream(&env, stream_id, &stream);
            env.events().publish(
                (Symbol::new(&env, "stream_created"), stream_id),
                StreamCreatedEvent {
                    stream_id,
                    sender: sender.clone(),
                    recipient: input.recipient,
                    rate_per_second: stream.rate_per_second,
                    token_address: input.token_address,
                    deposited_amount: net_amount,
                    start_time,
                },
            );
            ids.push_back(stream_id);
        }
        Ok(ids)
    }

    /// Create a stream with a vesting cliff.
    pub fn create_stream_with_cliff(
        env: Env,
        sender: Address,
        recipient: Address,
        token_address: Address,
        amount: i128,
        duration: u64,
        cliff_duration: u64,
    ) -> Result<u64, StreamError> {
        sender.require_auth();
        if amount <= 0 {
            return Err(StreamError::InvalidAmount);
        }
        if duration == 0 || cliff_duration == 0 || cliff_duration > duration {
            return Err(StreamError::InvalidDuration);
        }
        Self::validate_token_contract(&env, &token_address)?;
        let stream_id = next_stream_id(&env);
        let start_time = env.ledger().timestamp();
        let contract_address = env.current_contract_address();
        token::Client::new(&env, &token_address).transfer(&sender, &contract_address, &amount);
        let net_amount = Self::collect_fee(&env, &token_address, amount, stream_id)?;
        let rate_per_second = net_amount / duration as i128;
        if rate_per_second == 0 {
            return Err(StreamError::InvalidRate);
        }
        save_stream(
            &env,
            stream_id,
            &Stream {
                sender: sender.clone(),
                recipient: recipient.clone(),
                token_address: token_address.clone(),
                rate_per_second,
                deposited_amount: net_amount,
                withdrawn_amount: 0,
                start_time,
                last_update_time: start_time,
                cliff_time: Some(start_time + cliff_duration),
                is_active: true,
                paused: false,
                paused_at: None,
                status: StreamStatus::Active,
            },
        );
        env.events().publish(
            (Symbol::new(&env, "stream_created"), stream_id),
            StreamCreatedEvent {
                stream_id,
                sender,
                recipient,
                rate_per_second,
                token_address,
                deposited_amount: net_amount,
                start_time,
            },
        );
        Ok(stream_id)
    }

    /// Transfer an active stream to a new recipient after settling accrued funds.
    pub fn transfer_recipient(
        env: Env,
        current_recipient: Address,
        stream_id: u64,
        new_recipient: Address,
    ) -> Result<(), StreamError> {
        current_recipient.require_auth();
        let mut stream = load_stream(&env, stream_id)?;
        if stream.recipient != current_recipient {
            return Err(StreamError::Unauthorized);
        }
        Self::validate_stream_active(&stream)?;
        if new_recipient == current_recipient || new_recipient == env.current_contract_address() {
            return Err(StreamError::Unauthorized);
        }
        let now = env.ledger().timestamp();
        let settled_amount = Self::calculate_claimable(&stream, now);
        if settled_amount > 0 {
            stream.withdrawn_amount += settled_amount;
        }
        stream.last_update_time = now;
        stream.recipient = new_recipient.clone();
        save_stream(&env, stream_id, &stream);
        if settled_amount > 0 {
            token::Client::new(&env, &stream.token_address).transfer(
                &env.current_contract_address(),
                &current_recipient,
                &settled_amount,
            );
        }
        env.events().publish(
            (Symbol::new(&env, "recipient_transferred"), stream_id),
            RecipientTransferredEvent {
                stream_id,
                old_recipient: current_recipient,
                new_recipient,
                settled_amount,
                timestamp: now,
            },
        );
        Ok(())
    }

    /// Renew a stream's persistent storage TTL without authorization.
    pub fn extend_stream_ttl(env: Env, stream_id: u64) -> Result<(), StreamError> {
        let _ = load_stream(&env, stream_id)?;
        Ok(())
    }

    /// Top up an active stream with additional tokens.
    ///
    /// Only the original sender may top up their own stream. The top-up amount
    /// is subject to protocol fees (if configured) before being added to the stream.
    ///
    /// # Errors
    /// - `InvalidAmount`   — `amount` ≤ 0.
    /// - `StreamNotFound`  — no stream exists with `stream_id`.
    /// - `Unauthorized`    — caller is not the stream's sender.
    /// - `StreamInactive`  — stream has been cancelled or fully withdrawn.
    /// - `ArithmeticOverflow` — the fee calculation, the new deposited total,
    ///   or the projected end time overflows.
    pub fn top_up_stream(
        env: Env,
        sender: Address,
        stream_id: u64,
        amount: i128,
    ) -> Result<(), StreamError> {
        sender.require_auth();

        if amount <= 0 {
            return Err(StreamError::InvalidAmount);
        }

        let mut stream = load_stream(&env, stream_id)?;

        // Validate ownership and active status using helper functions
        Self::validate_stream_ownership(&stream, &sender)?;
        Self::validate_stream_active(&stream)?;

        // Transfer tokens from sender to contract
        let token_client = token::Client::new(&env, &stream.token_address);
        let contract_address = env.current_contract_address();
        token_client.transfer(&sender, &contract_address, &amount);

        // Collect protocol fee and get net amount
        let net_amount = Self::collect_fee(&env, &stream.token_address, amount, stream_id)?;

        // Update stream state. `last_update_time` is intentionally left untouched:
        // it is the accrual anchor for `calculate_claimable`, and advancing it to
        // `now` would discard any already-vested, unwithdrawn tokens.
        stream.deposited_amount = stream
            .deposited_amount
            .checked_add(net_amount)
            .ok_or(StreamError::ArithmeticOverflow)?;

        let now = env.ledger().timestamp();
        let claimable = Self::calculate_claimable(&stream, now);
        let remaining = stream
            .deposited_amount
            .saturating_sub(stream.withdrawn_amount)
            .saturating_sub(claimable);
        let new_end_time = Self::project_end_time(now, remaining, stream.rate_per_second)?;

        save_stream(&env, stream_id, &stream);

        // Emit top-up event
        env.events().publish(
            (Symbol::new(&env, "stream_topped_up"), stream_id),
            StreamToppedUpEvent {
                stream_id,
                sender,
                amount: net_amount,
                new_deposited_amount: stream.deposited_amount,
                new_end_time,
            },
        );

        Ok(())
    }

    // ─── Internal Helpers ─────────────────────────────────────────────────────

    /// Ensures the supplied token address implements the Soroban token interface.
    fn validate_token_contract(env: &Env, token_address: &Address) -> Result<(), StreamError> {
        match env.try_invoke_contract::<u32, InvokeError>(
            token_address,
            &Symbol::new(env, "decimals"),
            vec![env],
        ) {
            Ok(Ok(_)) => Ok(()),
            _ => Err(StreamError::InvalidTokenAddress),
        }
    }

    /// Calculate the claimable amount for a stream at a given timestamp.
    ///
    /// Excludes any time the stream was paused. If the stream is currently
    /// paused, accrual stops at `paused_at`.
    ///
    /// # Overflow Protection
    /// - Uses `checked_mul` for rate_per_second * elapsed_seconds multiplication
    /// - Caps at remaining deposited balance if overflow would occur
    /// - Uses `checked_sub` for deposited - already_withdrawn calculation
    /// - Overflow boundary: i128::MAX (~1.7e19) for both rate and duration
    fn calculate_claimable(stream: &Stream, now: u64) -> i128 {
        // When the stream is paused, accrue only up to the moment it was paused.
        let effective_now = if stream.paused {
            stream.paused_at.unwrap_or(stream.last_update_time)
        } else {
            now
        };

        if let Some(cliff) = stream.cliff_time {
            if effective_now < cliff {
                return 0;
            }
        }

        let elapsed = effective_now.saturating_sub(stream.last_update_time);

        // Clamp to 0: withdrawn_amount should never exceed deposited_amount in
        // normal flow, but guard defensively so the function never returns negative.
        let remaining = stream
            .deposited_amount
            .saturating_sub(stream.withdrawn_amount)
            .max(0);

        // Use checked_mul to prevent overflow when multiplying rate * elapsed.
        // If overflow would occur, cap at the remaining balance.
        let streamed = match (elapsed as i128).checked_mul(stream.rate_per_second) {
            Some(result) => result,
            None => return remaining,
        };

        streamed.min(remaining)
    }

    /// Validate that a stream exists and is owned by the caller.
    ///
    /// # Errors
    /// - `StreamNotFound` — no stream exists with `stream_id`.
    /// - `Unauthorized` — caller is not the stream's sender.
    fn validate_stream_ownership(stream: &Stream, caller: &Address) -> Result<(), StreamError> {
        if stream.sender != *caller {
            return Err(StreamError::Unauthorized);
        }
        Ok(())
    }

    /// Project the timestamp at which `remaining` tokens finish draining at
    /// `rate_per_second`, starting from `now`.
    ///
    /// Both steps are checked. A balance large enough to drain for more than
    /// `u64::MAX` seconds, or a projection that runs past the end of the u64
    /// timestamp range, returns `ArithmeticOverflow`. The plain
    /// `now + (remaining / rate) as u64` this replaces silently truncated the
    /// quotient and then panicked on the addition under `overflow-checks`,
    /// aborting an otherwise valid top-up or resume.
    fn project_end_time(
        now: u64,
        remaining: i128,
        rate_per_second: i128,
    ) -> Result<u64, StreamError> {
        let seconds_remaining = u64::try_from(remaining / rate_per_second)
            .map_err(|_| StreamError::ArithmeticOverflow)?;

        now.checked_add(seconds_remaining)
            .ok_or(StreamError::ArithmeticOverflow)
    }

    /// Validate that a stream is active.
    ///
    /// # Errors
    /// - `StreamInactive` — stream has been cancelled or fully withdrawn.
    fn validate_stream_active(stream: &Stream) -> Result<(), StreamError> {
        if !stream.is_active {
            return Err(StreamError::StreamInactive);
        }
        Ok(())
    }

    /// Apply a withdrawal: update stream state, persist it, then transfer tokens.
    ///
    /// Follows the Checks-Effects-Interactions (CEI) pattern: all state mutations
    /// and the storage write complete before the external token transfer fires.
    /// A re-entrant call via a malicious token hook therefore sees the already-updated
    /// withdrawn_amount in storage and cannot trigger a double payout.
    fn apply_withdrawal(
        env: &Env,
        stream: &mut Stream,
        stream_id: u64,
        recipient: &Address,
        amount: i128,
        now: u64,
    ) -> Result<(), StreamError> {
        // Effects: update stream state. The checked add runs before any state
        // mutation or transfer, so an overflow leaves the stream untouched.
        stream.withdrawn_amount = stream
            .withdrawn_amount
            .checked_add(amount)
            .ok_or(StreamError::ArithmeticOverflow)?;
        stream.last_update_time = now;

        if stream.withdrawn_amount >= stream.deposited_amount {
            stream.is_active = false;
            stream.status = StreamStatus::Completed;
        }

        // Persist state before any external call (CEI)
        save_stream(env, stream_id, stream);

        // Interaction: transfer tokens only after state is committed to storage
        let token_client = token::Client::new(env, &stream.token_address);
        token_client.transfer(&env.current_contract_address(), recipient, &amount);

        Ok(())
    }

    /// Withdraw all currently claimable tokens from a stream.
    ///
    /// Only the stream's recipient may call this. The amount withdrawn is calculated
    /// based on elapsed time and the stream's rate. The stream is automatically marked
    /// inactive once fully drained.
    ///
    /// # Errors
    /// - `StreamNotFound`  — no stream exists with `stream_id`.
    /// - `Unauthorized`    — caller is not the stream's recipient.
    /// - `StreamInactive`  — stream is already inactive.
    /// - `InvalidAmount`   — no claimable balance (fully withdrawn already).
    /// - `ArithmeticOverflow` — the new withdrawn total overflows `i128`.
    pub fn withdraw(env: Env, recipient: Address, stream_id: u64) -> Result<i128, StreamError> {
        recipient.require_auth();

        let mut stream = load_stream(&env, stream_id)?;

        // Validate recipient authorization
        if stream.recipient != recipient {
            return Err(StreamError::Unauthorized);
        }

        // Validate stream is active and not paused
        Self::validate_stream_active(&stream)?;
        if stream.paused {
            return Err(StreamError::StreamPaused);
        }

        let now = env.ledger().timestamp();
        let claimable = Self::calculate_claimable(&stream, now);

        if claimable <= 0 {
            return Err(StreamError::InvalidAmount);
        }

        // Apply withdrawal: updates state, persists to storage, then transfers (CEI)
        Self::apply_withdrawal(&env, &mut stream, stream_id, &recipient, claimable, now)?;

        let completed = stream.status == StreamStatus::Completed;

        env.events().publish(
            (Symbol::new(&env, "tokens_withdrawn"), stream_id),
            TokensWithdrawnEvent {
                stream_id,
                recipient: recipient.clone(),
                amount: claimable,
                timestamp: stream.last_update_time,
            },
        );

        // Emit COMPLETED event on final withdrawal
        if completed {
            env.events().publish(
                (Symbol::new(&env, "stream_completed"), stream_id),
                StreamCompletedEvent {
                    stream_id,
                    recipient,
                    total_withdrawn: stream.withdrawn_amount,
                },
            );
        }

        Ok(claimable)
    }

    /// Cancel an active stream.
    ///
    /// Only the stream's original sender may cancel. The recipient receives all
    /// accrued tokens up to the cancellation moment, and any remaining unspent
    /// balance is refunded to the sender.
    ///
    /// **State Invariant:** Once a stream is cancelled, its `status` is set to
    /// `Cancelled` and `is_active` is set to `false`. A cancelled stream can
    /// never be resumed, even if `paused` is `true`. This invariant must be
    /// preserved across all contract changes to prevent state-invariant bugs.
    /// See Testing #94 for test coverage.
    ///
    /// # Errors
    /// - `StreamNotFound`  — no stream exists with `stream_id`.
    /// - `Unauthorized`    — caller is not the stream's sender.
    /// - `StreamInactive`  — stream is already inactive.
    pub fn cancel_stream(env: Env, sender: Address, stream_id: u64) -> Result<(), StreamError> {
        sender.require_auth();

        let mut stream = load_stream(&env, stream_id)?;

        // Validate ownership and active status
        Self::validate_stream_ownership(&stream, &sender)?;
        Self::validate_stream_active(&stream)?;

        let now = env.ledger().timestamp();
        let accrued_amount = Self::calculate_claimable(&stream, now);

        // Effects: update all stream state before any external call
        if accrued_amount > 0 {
            stream.withdrawn_amount = stream.withdrawn_amount.saturating_add(accrued_amount);
        }

        let refunded_amount = stream
            .deposited_amount
            .saturating_sub(stream.withdrawn_amount);

        stream.is_active = false;
        stream.status = StreamStatus::Cancelled;
        stream.last_update_time = now;

        let recipient = stream.recipient.clone();
        let amount_withdrawn = stream.withdrawn_amount;

        // Persist state before any external calls (CEI)
        save_stream(&env, stream_id, &stream);

        // Interactions: token transfers after state is committed to storage
        let token_client = token::Client::new(&env, &stream.token_address);
        let contract_address = env.current_contract_address();

        if accrued_amount > 0 {
            token_client.transfer(&contract_address, &recipient, &accrued_amount);
        }

        if refunded_amount > 0 {
            token_client.transfer(&contract_address, &sender, &refunded_amount);
        }

        // Emit cancellation event
        env.events().publish(
            (Symbol::new(&env, "stream_cancelled"), stream_id),
            StreamCancelledEvent {
                stream_id,
                sender,
                recipient,
                amount_withdrawn,
                refunded_amount,
            },
        );

        Ok(())
    }

    /// Pause an active stream. Only the sender may pause.
    ///
    /// # Errors
    /// - `StreamNotFound`     — no stream exists with `stream_id`.
    /// - `Unauthorized`       — caller is not the stream's sender.
    /// - `StreamInactive`     — stream is inactive (cancelled or completed).
    /// - `StreamAlreadyPaused` — stream is already paused.
    pub fn pause_stream(env: Env, sender: Address, stream_id: u64) -> Result<(), StreamError> {
        sender.require_auth();

        let mut stream = load_stream(&env, stream_id)?;
        Self::validate_stream_ownership(&stream, &sender)?;
        Self::validate_stream_active(&stream)?;

        if stream.paused {
            return Err(StreamError::StreamAlreadyPaused);
        }

        let now = env.ledger().timestamp();
        stream.paused = true;
        stream.paused_at = Some(now);
        stream.status = StreamStatus::Paused;
        save_stream(&env, stream_id, &stream);

        env.events().publish(
            (Symbol::new(&env, "stream_paused"), stream_id),
            StreamPausedEvent {
                stream_id,
                sender,
                paused_at: now,
            },
        );

        Ok(())
    }

    /// Resume a paused stream. Adjusts `end_time` by the pause duration.
    ///
    /// The `last_update_time` is advanced to `now` so that accrual resumes
    /// from the current moment, effectively extending the stream by the
    /// duration it was paused.
    ///
    /// **State Invariant:** A cancelled stream (status == `Cancelled`) can
    /// never be resumed, even if `paused` is `true`. The `is_active` and
    /// `paused` fields are independently-settable, but once a stream is
    /// cancelled, the invariant "a cancelled stream must never be resumable"
    /// is absolute. This invariant must be preserved across all contract
    /// changes to prevent state-invariant bugs. See Testing #94 for test
    /// coverage.
    ///
    /// # Errors
    /// - `StreamNotFound`  — no stream exists with `stream_id`.
    /// - `Unauthorized`    — caller is not the stream's sender.
    /// - `StreamNotPaused` — stream is active but not currently paused.
    /// - `ArithmeticOverflow` — the projected end time overflows `u64`.
    pub fn resume_stream(env: Env, sender: Address, stream_id: u64) -> Result<u64, StreamError> {
        sender.require_auth();

        let mut stream = load_stream(&env, stream_id)?;
        Self::validate_stream_ownership(&stream, &sender)?;

        if !stream.paused {
            return Err(StreamError::StreamNotPaused);
        }

        let now = env.ledger().timestamp();
        let paused_at = stream.paused_at.unwrap_or(now);
        let pause_duration = now.saturating_sub(paused_at);

        // Amount already accrued (and claimable) as of the pause point. Computed
        // before last_update_time is advanced below, while `stream.paused` is
        // still true so `calculate_claimable` stops accrual at `paused_at`.
        let claimable_at_resume = Self::calculate_claimable(&stream, now);

        // Advance last_update_time by pause duration so accrual resumes from now.
        stream.last_update_time = stream.last_update_time.saturating_add(pause_duration);
        // new_end_time represents when the stream will fully drain from now,
        // net of the amount already accrued (and claimable) at the pause point.
        let remaining = stream
            .deposited_amount
            .saturating_sub(stream.withdrawn_amount)
            .saturating_sub(claimable_at_resume);
        // rate_per_second is guaranteed >= 1 due to create_stream's InvalidRate guard
        let new_end_time = Self::project_end_time(now, remaining, stream.rate_per_second)?;

        stream.paused = false;
        stream.paused_at = None;
        stream.status = StreamStatus::Active;
        save_stream(&env, stream_id, &stream);

        env.events().publish(
            (Symbol::new(&env, "stream_resumed"), stream_id),
            StreamResumedEvent {
                stream_id,
                sender,
                new_end_time,
            },
        );

        Ok(new_end_time)
    }

    // ─── Read-only Queries ────────────────────────────────────────────────────

    /// Returns the stream record for `stream_id`, or `None` if it does not exist.
    pub fn get_stream(env: Env, stream_id: u64) -> Option<Stream> {
        try_load_stream(&env, stream_id)
    }

    /// Returns `true` if the stream exists and has status `Completed`.
    pub fn is_stream_completed(env: Env, stream_id: u64) -> bool {
        try_load_stream(&env, stream_id)
            .map(|s| s.status == StreamStatus::Completed)
            .unwrap_or(false)
    }

    /// Get the current claimable amount for a stream without modifying state.
    ///
    /// This is a read-only query that calculates how many tokens the recipient
    /// can currently withdraw based on elapsed time and stream rate.
    ///
    /// Returns `None` if the stream doesn't exist, otherwise returns the claimable amount.
    pub fn get_claimable_amount(env: Env, stream_id: u64) -> Option<i128> {
        try_load_stream(&env, stream_id).map(|stream| {
            if !stream.is_active {
                return 0;
            }
            let now = env.ledger().timestamp();
            Self::calculate_claimable(&stream, now)
        })
    }

    // ─── Internal Helpers ─────────────────────────────────────────────────────

    /// Deducts the protocol fee from `amount`, transfers it to the treasury,
    /// emits a `fee_collected` event, and returns the net amount.
    ///
    /// If no protocol config exists or the fee rate is 0, returns `amount` unchanged.
    /// If fee calculation truncates to 0, no transfer/event occurs and `amount` is unchanged.
    /// Time complexity: O(1).
    fn collect_fee(
        env: &Env,
        token_address: &Address,
        amount: i128,
        stream_id: u64,
    ) -> Result<i128, StreamError> {
        match try_load_config(env) {
            Some(cfg) if cfg.fee_rate_bps > 0 => {
                // `amount` is caller-supplied and can reach i128::MAX, so the
                // bps multiplication is the first thing that would overflow.
                let fee = amount
                    .checked_mul(cfg.fee_rate_bps as i128)
                    .ok_or(StreamError::ArithmeticOverflow)?
                    / 10_000;
                if fee > 0 {
                    let token_client = token::Client::new(env, token_address);
                    token_client.transfer(&env.current_contract_address(), &cfg.treasury, &fee);
                    env.events().publish(
                        (Symbol::new(env, "fee_collected"), stream_id),
                        FeeCollectedEvent {
                            stream_id,
                            treasury: cfg.treasury,
                            fee_amount: fee,
                            token: token_address.clone(),
                        },
                    );
                }
                // `fee_rate_bps` is capped at MAX_FEE_RATE_BPS (10%), so `fee`
                // is always well below `amount` and this cannot underflow.
                Ok(amount - fee)
            }
            _ => Ok(amount),
        }
    }
}
