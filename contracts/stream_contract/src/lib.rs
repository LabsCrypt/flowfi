#![no_std]

mod errors;
mod events;
mod storage;
mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, token, vec, Address, Env, InvokeError, Symbol};

use errors::StreamError;
use events::{
    FeeCollectedEvent, StreamCancelledEvent, StreamCompletedEvent, StreamCreatedEvent,
    StreamPausedEvent, StreamResumedEvent, StreamToppedUpEvent, TokensWithdrawnEvent,
};
use storage::{
    config_exists, load_config, load_stream, next_stream_id, save_config, save_stream,
    try_load_config, try_load_stream,
};
use types::{ProtocolConfig, Stream, StreamStatus};

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
                admin: config.admin,
                treasury,
                fee_rate_bps,
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
    /// `rate_per_second = net_amount / duration`. Any remainder from the division
    /// is truncated from `rate_per_second`. This means at exactly `start_time + duration`,
    /// the claimable amount will be slightly less than `net_amount`. 
    /// The remainder is only claimable if the stream runs past the initial duration,
    /// or it is refunded to the sender if the stream is cancelled exactly at the end of the duration.
    ///
    /// Returns the new stream ID (starts at 1, increments monotonically).
    ///
    /// # Errors
    /// - `InvalidAmount`   — `amount` ≤ 0.
    /// - `InvalidDuration` — `duration` is 0.
    /// - `InvalidTokenAddress` — `token_address` is not a token contract.
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
        let net_amount = Self::collect_fee(&env, &token_address, amount, stream_id);
        let rate_per_second = net_amount / (duration as i128);

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
        let net_amount = Self::collect_fee(&env, &stream.token_address, amount, stream_id);

        // Update stream state
        stream.deposited_amount += net_amount;
        stream.last_update_time = env.ledger().timestamp();

        save_stream(&env, stream_id, &stream);

        // Emit top-up event
        env.events().publish(
            (Symbol::new(&env, "stream_topped_up"), stream_id),
            StreamToppedUpEvent {
                stream_id,
                sender,
                amount: net_amount,
                new_deposited_amount: stream.deposited_amount,
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
    /// - Caps at stream.deposited_amount if overflow would occur
    /// - Uses `checked_sub` for deposited - already_withdrawn calculation
    /// - Overflow boundary: i128::MAX (~1.7e19) for both rate and duration
    fn calculate_claimable(stream: &Stream, now: u64) -> i128 {
        let effective_now = if stream.paused {
            stream.paused_at.unwrap_or(stream.last_update_time)
        } else {
            now
        };
        let elapsed = effective_now.saturating_sub(stream.last_update_time);

        // Use checked_mul to prevent overflow when multiplying rate * elapsed
        // If overflow would occur, cap at deposited_amount (full deposit)
        let streamed = match (elapsed as i128).checked_mul(stream.rate_per_second) {
            Some(result) => result,
            None => return stream.deposited_amount, // Overflow: cap at full deposit
        };

        // Use checked_sub for deposited - withdrawn calculation
        let remaining = match stream
            .deposited_amount
            .checked_sub(stream.withdrawn_amount)
        {
            Some(result) => result,
            None => 0, // Underflow: already withdrawn more than deposited
        };

        streamed.min(remaining)
    }

    /// Validate that a stream exists and is owned by the caller.
    ///
    /// # Errors
    /// - `StreamNotFound` — no stream exists with `stream_id`.
    /// - `Unauthorized` — caller is not the stream's sender.
    fn validate_stream_ownership(
        stream: &Stream,
        caller: &Address,
    ) -> Result<(), StreamError> {
        if stream.sender != *caller {
            return Err(StreamError::Unauthorized);
        }
        Ok(())
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

    /// Transfer tokens from contract to recipient and update stream state.
    ///
    /// This helper consolidates the token transfer logic and stream state updates
    /// to reduce code duplication across withdrawal operations.
    fn transfer_and_update_stream(
        env: &Env,
        stream: &mut Stream,
        recipient: &Address,
        amount: i128,
        now: u64,
    ) {
        let token_client = token::Client::new(env, &stream.token_address);
        let contract_address = env.current_contract_address();
        token_client.transfer(&contract_address, recipient, &amount);

        stream.withdrawn_amount += amount;
        stream.last_update_time = now;

        // Mark stream as inactive and completed if fully drained
        if stream.withdrawn_amount >= stream.deposited_amount {
            stream.is_active = false;
            stream.status = StreamStatus::Completed;
        }
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
            return Err(StreamError::StreamInactive);
        }

        let now = env.ledger().timestamp();
        let claimable = Self::calculate_claimable(&stream, now);

        if claimable <= 0 {
            return Err(StreamError::InvalidAmount);
        }

        // Use helper function to transfer tokens and update state
        Self::transfer_and_update_stream(&env, &mut stream, &recipient, claimable, now);

        let completed = stream.status == StreamStatus::Completed;
        save_stream(&env, stream_id, &stream);

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

        let token_client = token::Client::new(&env, &stream.token_address);
        let contract_address = env.current_contract_address();

        // Settle recipient with all accrued tokens at cancellation
        if accrued_amount > 0 {
            token_client.transfer(&contract_address, &stream.recipient, &accrued_amount);
            stream.withdrawn_amount = stream.withdrawn_amount.saturating_add(accrued_amount);
        }

        // Calculate and refund remaining balance to sender
        let refunded_amount = stream
            .deposited_amount
            .saturating_sub(stream.withdrawn_amount);

        if refunded_amount > 0 {
            token_client.transfer(&contract_address, &sender, &refunded_amount);
        }

        // Mark stream as inactive
        stream.is_active = false;
        stream.status = StreamStatus::Cancelled;
        stream.last_update_time = now;

        let recipient = stream.recipient.clone();
        let amount_withdrawn = stream.withdrawn_amount;

        save_stream(&env, stream_id, &stream);

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
    /// - `StreamNotFound`  — no stream exists with `stream_id`.
    /// - `Unauthorized`    — caller is not the stream's sender.
    /// - `StreamInactive`  — stream is already inactive.
    pub fn pause_stream(env: Env, sender: Address, stream_id: u64) -> Result<(), StreamError> {
        sender.require_auth();

        let mut stream = load_stream(&env, stream_id)?;
        Self::validate_stream_ownership(&stream, &sender)?;
        Self::validate_stream_active(&stream)?;

        if stream.paused {
            return Err(StreamError::StreamInactive);
        }

        let now = env.ledger().timestamp();
        stream.paused = true;
        stream.paused_at = Some(now);
        stream.status = StreamStatus::Paused;
        save_stream(&env, stream_id, &stream);

        env.events().publish(
            (Symbol::new(&env, "stream_paused"), stream_id),
            StreamPausedEvent { stream_id, sender, paused_at: now },
        );

        Ok(())
    }

    /// Resume a paused stream. Adjusts `end_time` by the pause duration.
    ///
    /// The `last_update_time` is advanced to `now` so that accrual resumes
    /// from the current moment, effectively extending the stream by the
    /// duration it was paused.
    ///
    /// # Errors
    /// - `StreamNotFound`  — no stream exists with `stream_id`.
    /// - `Unauthorized`    — caller is not the stream's sender.
    /// - `StreamInactive`  — stream is not paused (already active or cancelled).
    pub fn resume_stream(env: Env, sender: Address, stream_id: u64) -> Result<u64, StreamError> {
        sender.require_auth();

        let mut stream = load_stream(&env, stream_id)?;
        Self::validate_stream_ownership(&stream, &sender)?;

        if !stream.paused {
            return Err(StreamError::StreamInactive);
        }

        let now = env.ledger().timestamp();
        let paused_at = stream.paused_at.unwrap_or(now);
        let pause_duration = now.saturating_sub(paused_at);

        // Advance last_update_time by pause duration so accrual resumes from now.
        stream.last_update_time = stream.last_update_time.saturating_add(pause_duration);
        // new_end_time represents when the stream will fully drain from now.
        let remaining = stream.deposited_amount.saturating_sub(stream.withdrawn_amount);
        let new_end_time = if stream.rate_per_second > 0 {
            now + (remaining / stream.rate_per_second) as u64
        } else {
            now
        };

        stream.paused = false;
        stream.paused_at = None;
        stream.status = StreamStatus::Active;
        save_stream(&env, stream_id, &stream);

        env.events().publish(
            (Symbol::new(&env, "stream_resumed"), stream_id),
            StreamResumedEvent { stream_id, sender, new_end_time },
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
    /// Time complexity: O(1).
    fn collect_fee(env: &Env, token_address: &Address, amount: i128, stream_id: u64) -> i128 {
        match try_load_config(env) {
            Some(cfg) if cfg.fee_rate_bps > 0 => {
                let fee = amount * (cfg.fee_rate_bps as i128) / 10_000;
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
                amount - fee
            }
            _ => amount,
        }
    }
}
