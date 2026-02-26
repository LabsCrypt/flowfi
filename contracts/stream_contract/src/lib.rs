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
    FeeCollectedEvent, StreamCancelledEvent, StreamCreatedEvent, StreamToppedUpEvent,
    TokensWithdrawnEvent,
};
use storage::{
    config_exists, load_config, load_stream, next_stream_id, save_config, save_stream,
    try_load_config, try_load_stream,
};
use types::{ProtocolConfig, Stream};

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
    /// `rate_per_second = net_amount / duration`.
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
    /// Only the original sender may top up their own stream.
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

        if stream.sender != sender {
            return Err(StreamError::Unauthorized);
        }
        if !stream.is_active {
            return Err(StreamError::StreamInactive);
        }

        let token_client = token::Client::new(&env, &stream.token_address);
        let contract_address = env.current_contract_address();
        token_client.transfer(&sender, &contract_address, &amount);

        let net_amount = Self::collect_fee(&env, &stream.token_address, amount, stream_id);

        stream.deposited_amount += net_amount;
        stream.last_update_time = env.ledger().timestamp();

        save_stream(&env, stream_id, &stream);

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

    fn calculate_claimable(stream: &Stream, now: u64) -> i128 {
        let elapsed = now.saturating_sub(stream.last_update_time);

        let streamed = (elapsed as i128)
            .checked_mul(stream.rate_per_second)
            .unwrap_or(i128::MAX);

        let remaining = stream
            .deposited_amount
            .saturating_sub(stream.withdrawn_amount);

        if streamed > remaining {
            remaining
        } else {
            streamed
        }
    }

    /// Withdraw all currently claimable tokens from a stream.
    ///
    /// Only the stream's recipient may call this. The stream is marked
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

        if stream.recipient != recipient {
            return Err(StreamError::Unauthorized);
        }
        if !stream.is_active {
            return Err(StreamError::StreamInactive);
        }

        let now = env.ledger().timestamp();
        let claimable = Self::calculate_claimable(&stream, now);

        if claimable <= 0 {
            return Err(StreamError::InvalidAmount);
        }

        let token_client = token::Client::new(&env, &stream.token_address);
        let contract_address = env.current_contract_address();
        token_client.transfer(&contract_address, &recipient, &claimable);

        stream.withdrawn_amount += claimable;
        stream.last_update_time = now;

        // Mark stream as inactive if all funds have been withdrawn
        if stream.withdrawn_amount >= stream.deposited_amount {
            stream.is_active = false;
        }

        save_stream(&env, stream_id, &stream);

        env.events().publish(
            (Symbol::new(&env, "tokens_withdrawn"), stream_id),
            TokensWithdrawnEvent {
                stream_id,
                recipient,
                amount: claimable,
                timestamp: stream.last_update_time,
            },
        );

        Ok(claimable)
    }

    /// Cancel an active stream.
    ///
    /// Only the stream's original sender may cancel. Any unspent balance
    /// (deposited − withdrawn) is returned to the sender.
    ///
    /// # Errors
    /// - `StreamNotFound`  — no stream exists with `stream_id`.
    /// - `Unauthorized`    — caller is not the stream's sender.
    /// - `StreamInactive`  — stream is already inactive.
    pub fn cancel_stream(env: Env, sender: Address, stream_id: u64) -> Result<(), StreamError> {
        sender.require_auth();

        let mut stream = load_stream(&env, stream_id)?;

        if stream.sender != sender {
            return Err(StreamError::Unauthorized);
        }
        if !stream.is_active {
            return Err(StreamError::StreamInactive);
        }

        // Calculate accrued tokens that belong to the recipient
        let now = env.ledger().timestamp();
        let accrued_amount = Self::calculate_claimable(&stream, now);

        let token_client = token::Client::new(&env, &stream.token_address);
        let contract_address = env.current_contract_address();

        // Settle recipient immediately with all final claimable amount at cancellation.
        if accrued_amount > 0 {
            token_client.transfer(&contract_address, &stream.recipient, &accrued_amount);
            stream.withdrawn_amount = stream.withdrawn_amount.saturating_add(accrued_amount);
        }

        // Refund remaining unspent balance after recipient settlement.
        let refunded_amount = stream
            .deposited_amount
            .saturating_sub(stream.withdrawn_amount);

        if refunded_amount > 0 {
            token_client.transfer(&contract_address, &sender, &refunded_amount);
        }

        stream.is_active = false;
        stream.last_update_time = now;

        let recipient = stream.recipient.clone();
        let amount_withdrawn = stream.withdrawn_amount;

        save_stream(&env, stream_id, &stream);

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

    // ─── Read-only Queries ────────────────────────────────────────────────────

    /// Returns the stream record for `stream_id`, or `None` if it does not exist.
    pub fn get_stream(env: Env, stream_id: u64) -> Option<Stream> {
        try_load_stream(&env, stream_id)
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
