#![no_std]
#![doc = include_str!("../README.md")]
// A contract's entrypoint arity *is* its public ABI, and `#[contractimpl]` /
// `#[contractclient]` regenerate every client method with the same arity inside
// the macro expansion, where an item-level `allow` cannot reach. Suppressing the
// lint crate-wide is the only way to keep `-D warnings` meaningful elsewhere.
#![allow(clippy::too_many_arguments)]

mod errors;
mod events;
mod storage;
mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contractimpl, token, vec, Address, BytesN, Env, InvokeError, Symbol, Vec,
};

use errors::StreamError;
use events::{
    AdminTransferredEvent, ContractUpgradedEvent, EmergencyGuardianUpdatedEvent, FeeCollectedEvent,
    FeeConfigUpdatedEvent, HybridCliffStreamCreatedEvent, InitializedEvent,
    ProtocolPauseStatusEvent, StateMigratedEvent, StepVestingStreamCreatedEvent,
    StreamCancelledEvent, StreamCompletedEvent, StreamCreatedEvent, StreamPausedEvent,
    StreamResumedEvent, StreamToppedUpEvent, TokensWithdrawnEvent,
};
use storage::{
    config_exists, get_contract_version, get_recorded_wasm_hash, load_config, load_stream,
    next_stream_id, save_config, save_contract_version, save_recorded_wasm_hash, save_stream,
    try_load_config, try_load_stream,
};
use types::{
    ProtocolConfig, Stream, StreamStatus, VestingSchedule, VestingStep, MAX_BATCH_WITHDRAW,
    MAX_VESTING_STEPS,
};

/// Maximum allowed protocol fee: 1 000 bps = 10%.
const MAX_FEE_RATE_BPS: u32 = 1_000;

/// Current on-chain state schema version.
///
/// - `0` — unversioned, written before `DataKey::ContractVersion` existed.
///   `ProtocolConfig` has three fields and `Stream` has no `schedule`.
/// - `1` — reserved for versioned pre-circuit-breaker state.
/// - `2` — adds the protocol circuit breaker, the emergency guardian role and
///   the `VestingSchedule` discriminator to `Stream`.
const CURRENT_DATA_VERSION: u32 = 2;

#[contract]
pub struct StreamContract;

#[contractimpl]
impl StreamContract {
    // ─── Protocol Administration ──────────────────────────────────────────────

    /// One-time initialization of the protocol fee configuration.
    ///
    /// The protocol starts unpaused with no emergency guardian; set the latter
    /// with `set_emergency_guardian` once the protocol is live.
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
                is_protocol_paused: false,
                emergency_guardian: None,
            },
        );
        save_contract_version(&env, CURRENT_DATA_VERSION);

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
    /// Circuit-breaker and guardian state are deliberately left untouched.
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
                is_protocol_paused: config.is_protocol_paused,
                emergency_guardian: config.emergency_guardian,
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
    /// becomes the sole admin and the previous admin loses all admin privileges,
    /// including the ability to clear a protocol pause.
    ///
    /// The emergency guardian role *is* carried over, because dropping it
    /// mid-incident would hand the incoming admin a protocol that nobody can
    /// trip. The new admin holds `set_emergency_guardian` and can revoke or
    /// re-point the role whenever they choose. A pause already in effect stays
    /// in effect until explicitly cleared.
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
                is_protocol_paused: config.is_protocol_paused,
                emergency_guardian: config.emergency_guardian,
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

    /// Returns the current protocol configuration, or `None` if not yet initialized.
    pub fn get_fee_config(env: Env) -> Option<ProtocolConfig> {
        try_load_config(&env)
    }

    // ─── Circuit Breaker (F1) ─────────────────────────────────────────────────

    /// Trip or clear the protocol-wide circuit breaker.
    ///
    /// Authorization is deliberately asymmetric, following the emergency-stop
    /// pattern used across DeFi:
    /// - **Pausing** — the admin *or* the emergency guardian may trip it.
    /// - **Unpausing** — only the admin. A guardian that could also clear the
    ///   breaker could silently reinstate deposits during the very incident
    ///   that caused the pause, so a compromised guardian can only ever be
    ///   maximally restrictive.
    ///
    /// While paused, every token-*in* entrypoint (`create_stream`,
    /// `create_step_vesting_stream`, `create_hybrid_cliff_stream`,
    /// `top_up_stream`) reverts with `ProtocolPaused`. Every token-*out*
    /// entrypoint (`withdraw`, `batch_withdraw`, `cancel_stream`) stays open so
    /// a pause can neither censor withdrawals of vested funds nor trap capital.
    ///
    /// # Errors
    /// - `NotInitialized` — `initialize` has not been called.
    /// - `NotAdmin`       — caller is neither admin nor guardian, or is neither
    ///   admin nor guardian while attempting to unpause.
    pub fn set_protocol_pause(env: Env, caller: Address, paused: bool) -> Result<(), StreamError> {
        let mut config = load_config(&env)?;
        caller.require_auth();

        let authorized = if paused {
            // Admin or the configured guardian may trip the breaker.
            config.admin == caller || config.emergency_guardian.as_ref() == Some(&caller)
        } else {
            // Only the admin may clear it.
            config.admin == caller
        };

        if !authorized {
            return Err(if paused {
                StreamError::NotGuardian
            } else {
                StreamError::NotAdmin
            });
        }

        config.is_protocol_paused = paused;
        save_config(&env, &config);

        env.events().publish(
            (Symbol::new(&env, "protocol_pause_status"),),
            ProtocolPauseStatusEvent {
                caller,
                paused,
                timestamp: env.ledger().timestamp(),
            },
        );

        Ok(())
    }

    /// Returns `true` while the protocol-wide circuit breaker is engaged.
    pub fn is_protocol_paused(env: Env) -> bool {
        try_load_config(&env)
            .map(|c| c.is_protocol_paused)
            .unwrap_or(false)
    }

    /// Set or clear the emergency guardian. Admin-only.
    ///
    /// Passing `None` removes the guardian, leaving the admin as the only
    /// authority able to trip the breaker. Re-setting the guardian to the admin
    /// address is allowed and equivalent to having no separate guardian.
    ///
    /// # Errors
    /// - `NotInitialized` — `initialize` has not been called.
    /// - `NotAdmin`       — caller is not the current admin.
    pub fn set_emergency_guardian(
        env: Env,
        admin: Address,
        guardian: Option<Address>,
    ) -> Result<(), StreamError> {
        admin.require_auth();

        let mut config = load_config(&env)?;
        if config.admin != admin {
            return Err(StreamError::NotAdmin);
        }

        config.emergency_guardian = guardian.clone();
        save_config(&env, &config);

        env.events().publish(
            (Symbol::new(&env, "emergency_guardian_updated"),),
            EmergencyGuardianUpdatedEvent { admin, guardian },
        );

        Ok(())
    }

    /// Reverts with `ProtocolPaused` while the circuit breaker is engaged.
    ///
    /// Placed at the top of every token-in entrypoint. A missing config counts
    /// as "not paused" so that the guard never becomes a second, redundant
    /// initialization gate.
    fn require_not_protocol_paused(env: &Env) -> Result<(), StreamError> {
        if Self::is_protocol_paused(env.clone()) {
            return Err(StreamError::ProtocolPaused);
        }
        Ok(())
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
    /// - `ProtocolPaused`     — the circuit breaker is engaged.
    /// - `InvalidAmount`      — `amount` ≤ 0.
    /// - `InvalidDuration`    — `duration` is 0.
    /// - `InvalidRate`        — `net_amount / duration` rounds to zero.
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
        Self::require_not_protocol_paused(&env)?;

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
                is_active: true,
                paused: false,
                paused_at: None,
                status: StreamStatus::Active,
                schedule: VestingSchedule::Linear,
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

    /// Create a milestone (step-tranche) vesting stream.
    ///
    /// Instead of unlocking continuously, the deposited amount is released in
    /// discrete tranches: at ledger timestamp `T` the recipient may claim the
    /// sum of every `step.unlock_amount` whose `unlock_time` is `<= T`, minus
    /// whatever they have already withdrawn. This models institutional grants,
    /// VC tranches and executive packages inside a single stream instead of
    /// forcing the sender to fragment the award across N linear streams.
    ///
    /// Validation is strict because a malformed schedule is unrecoverable once
    /// funds are escrowed:
    /// - 1..=`MAX_VESTING_STEPS` steps,
    /// - strictly increasing `unlock_time`, each strictly after `start_time`,
    /// - strictly positive `unlock_amount`,
    /// - step amounts summing to exactly the post-fee deposited amount.
    ///
    /// Fee handling matches `create_stream`: the protocol fee is deducted from
    /// the gross `amount` and the steps must sum to that *net* figure.
    ///
    /// # Errors
    /// - `ProtocolPaused`              — the circuit breaker is engaged.
    /// - `InvalidAmount`               — `amount` ≤ 0.
    /// - `InvalidTokenAddress`         — `token_address` is not a token contract.
    /// - `EmptyVestingSchedule`        — `steps` is empty.
    /// - `TooManyVestingSteps`         — more than `MAX_VESTING_STEPS` steps.
    /// - `NonMonotonicVestingSteps`    — two steps share an `unlock_time` or are out of order.
    /// - `InvalidVestingStepAmount`    — a step amount is ≤ 0.
    /// - `VestingStepBeforeStart`      — a step unlocks at or before the stream start.
    /// - `VestingStepTotalMismatch`    — step amounts ≠ post-fee deposited amount.
    pub fn create_step_vesting_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token_address: Address,
        amount: i128,
        steps: Vec<VestingStep>,
    ) -> Result<u64, StreamError> {
        sender.require_auth();
        Self::require_not_protocol_paused(&env)?;

        if amount <= 0 {
            return Err(StreamError::InvalidAmount);
        }
        Self::validate_token_contract(&env, &token_address)?;

        let step_count = steps.len();
        if step_count == 0 {
            return Err(StreamError::EmptyVestingSchedule);
        }
        if step_count > MAX_VESTING_STEPS {
            return Err(StreamError::TooManyVestingSteps);
        }

        let stream_id = next_stream_id(&env);
        let start_time = env.ledger().timestamp();

        let token_client = token::Client::new(&env, &token_address);
        let contract_address = env.current_contract_address();
        token_client.transfer(&sender, &contract_address, &amount);

        let net_amount = Self::collect_fee(&env, &token_address, amount, stream_id);

        // Structural validation. Runs *after* the transfer so that the real
        // net amount is known, but a returned Err rolls the whole transaction
        // back including the transfer and the fee.
        Self::validate_step_schedule(&steps, start_time, net_amount)?;

        let last_unlock_time = steps.get(step_count - 1).unwrap().unlock_time;

        save_stream(
            &env,
            stream_id,
            &Stream {
                sender: sender.clone(),
                recipient: recipient.clone(),
                token_address: token_address.clone(),
                // Step schedules unlock by absolute timestamp, not by rate.
                rate_per_second: 0,
                deposited_amount: net_amount,
                withdrawn_amount: 0,
                start_time,
                last_update_time: start_time,
                is_active: true,
                paused: false,
                paused_at: None,
                status: StreamStatus::Active,
                schedule: VestingSchedule::StepTranches(steps),
            },
        );

        env.events().publish(
            (Symbol::new(&env, "step_vesting_stream_created"), stream_id),
            StepVestingStreamCreatedEvent {
                stream_id,
                sender,
                recipient,
                token_address,
                deposited_amount: net_amount,
                step_count,
                last_unlock_time,
            },
        );

        Ok(stream_id)
    }

    /// Create a cliff + linear hybrid stream.
    ///
    /// `cliff_unlock_amount` unlocks in one lump at absolute timestamp
    /// `cliff_time`; the remaining `deposited_amount - cliff_unlock_amount`
    /// then drips linearly at `(net - cliff) / linear_duration` per second.
    /// This is the common "4-year cliff, then monthly" compensation shape.
    ///
    /// # Errors
    /// - `ProtocolPaused`        — the circuit breaker is engaged.
    /// - `InvalidAmount`         — `amount` ≤ 0.
    /// - `InvalidTokenAddress`   — `token_address` is not a token contract.
    /// - `InvalidCliffParameters` — `cliff_time` not after start, `cliff_unlock_amount`
    ///   not in `(0, net)`, `linear_duration` 0, or the post-cliff rate rounds to zero.
    pub fn create_hybrid_cliff_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token_address: Address,
        amount: i128,
        cliff_time: u64,
        cliff_unlock_amount: i128,
        linear_duration: u64,
    ) -> Result<u64, StreamError> {
        sender.require_auth();
        Self::require_not_protocol_paused(&env)?;

        if amount <= 0 {
            return Err(StreamError::InvalidAmount);
        }
        if linear_duration == 0 {
            return Err(StreamError::InvalidCliffParameters);
        }
        Self::validate_token_contract(&env, &token_address)?;

        let stream_id = next_stream_id(&env);
        let start_time = env.ledger().timestamp();

        let token_client = token::Client::new(&env, &token_address);
        let contract_address = env.current_contract_address();
        token_client.transfer(&sender, &contract_address, &amount);

        let net_amount = Self::collect_fee(&env, &token_address, amount, stream_id);

        // The cliff must land strictly after creation, and must leave a
        // non-empty remainder so the linear component is well defined.
        if cliff_time <= start_time || cliff_unlock_amount <= 0 || cliff_unlock_amount >= net_amount
        {
            return Err(StreamError::InvalidCliffParameters);
        }

        let linear_amount = net_amount - cliff_unlock_amount;
        let rate_per_second = linear_amount / (linear_duration as i128);
        if rate_per_second == 0 {
            return Err(StreamError::InvalidCliffParameters);
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
                is_active: true,
                paused: false,
                paused_at: None,
                status: StreamStatus::Active,
                schedule: VestingSchedule::HybridCliffLinear(cliff_time, cliff_unlock_amount),
            },
        );

        env.events().publish(
            (Symbol::new(&env, "hybrid_cliff_stream_created"), stream_id),
            HybridCliffStreamCreatedEvent {
                stream_id,
                sender,
                recipient,
                token_address,
                deposited_amount: net_amount,
                cliff_time,
                cliff_unlock_amount,
                rate_per_second,
            },
        );

        Ok(stream_id)
    }

    /// Structural validation for a step-tranche schedule.
    ///
    /// Split out from `create_step_vesting_stream` so the same invariants can
    /// be asserted directly in tests.
    fn validate_step_schedule(
        steps: &Vec<VestingStep>,
        start_time: u64,
        net_amount: i128,
    ) -> Result<(), StreamError> {
        let mut total: i128 = 0;
        let mut previous_unlock_time: Option<u64> = None;

        for step in steps.iter() {
            if step.unlock_amount <= 0 {
                return Err(StreamError::InvalidVestingStepAmount);
            }
            if step.unlock_time <= start_time {
                return Err(StreamError::VestingStepBeforeStart);
            }
            // Strictly increasing: a duplicate or out-of-order timestamp would
            // make "sum of steps with unlock_time <= T" ambiguous at the boundary.
            if let Some(previous) = previous_unlock_time {
                if step.unlock_time <= previous {
                    return Err(StreamError::NonMonotonicVestingSteps);
                }
            }
            previous_unlock_time = Some(step.unlock_time);
            total = total.saturating_add(step.unlock_amount);
        }

        if total != net_amount {
            return Err(StreamError::VestingStepTotalMismatch);
        }

        Ok(())
    }

    /// Top up an active stream with additional tokens.
    ///
    /// Only the original sender may top up their own stream. The top-up amount
    /// is subject to protocol fees (if configured) before being added to the stream.
    ///
    /// Supported for the continuous-drip schedules ([`VestingSchedule::Linear`]
    /// and the linear tail of [`VestingSchedule::HybridCliffLinear`]), where a
    /// larger deposit simply extends the drain time at the same rate. Rejected
    /// for [`VestingSchedule::StepTranches`] with `TopUpUnsupported` — a step
    /// schedule must sum to exactly the deposited amount, so a top-up could
    /// either be stranded as unclaimable residue or silently deferred to the
    /// final milestone. Both would misstate when the recipient gets their money.
    ///
    /// # Errors
    /// - `ProtocolPaused`    — the circuit breaker is engaged.
    /// - `InvalidAmount`     — `amount` ≤ 0.
    /// - `StreamNotFound`    — no stream exists with `stream_id`.
    /// - `Unauthorized`      — caller is not the stream's sender.
    /// - `StreamInactive`    — stream has been cancelled or fully withdrawn.
    /// - `TopUpUnsupported`  — the stream uses a step-tranche schedule.
    pub fn top_up_stream(
        env: Env,
        sender: Address,
        stream_id: u64,
        amount: i128,
    ) -> Result<(), StreamError> {
        sender.require_auth();
        Self::require_not_protocol_paused(&env)?;

        if amount <= 0 {
            return Err(StreamError::InvalidAmount);
        }

        let mut stream = load_stream(&env, stream_id)?;

        // Validate ownership and active status using helper functions
        Self::validate_stream_ownership(&stream, &sender)?;
        Self::validate_stream_active(&stream)?;

        if matches!(stream.schedule, VestingSchedule::StepTranches(_)) {
            return Err(StreamError::TopUpUnsupported);
        }

        // Transfer tokens from sender to contract
        let token_client = token::Client::new(&env, &stream.token_address);
        let contract_address = env.current_contract_address();
        token_client.transfer(&sender, &contract_address, &amount);

        // Collect protocol fee and get net amount
        let net_amount = Self::collect_fee(&env, &stream.token_address, amount, stream_id);

        // Update stream state. `last_update_time` is intentionally left untouched:
        // it is the accrual anchor for `calculate_claimable`, and advancing it to
        // `now` would discard any already-vested, unwithdrawn tokens.
        stream.deposited_amount += net_amount;

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
    /// Dispatches on [`Stream::schedule`]:
    ///
    /// - [`VestingSchedule::Linear`] — accrues at `rate_per_second` from the
    ///   `last_update_time` anchor, so pauses are handled by `resume_stream`
    ///   shifting that anchor forward.
    /// - [`VestingSchedule::StepTranches`] — sums the `unlock_amount` of every
    ///   step whose absolute `unlock_time` has arrived, minus what has already
    ///   been withdrawn. Steps are strictly increasing, so the loop can stop at
    ///   the first future step.
    /// - [`VestingSchedule::HybridCliffLinear`] — the cliff lump once
    ///   `cliff_time` is reached, plus linear accrual from `cliff_time`.
    ///
    /// The two non-linear schedules are anchored to absolute ledger timestamps
    /// rather than to `last_update_time`. Their claim function is therefore
    /// always `total_unlocked(now) - withdrawn`, which is idempotent and cannot
    /// double-count across repeated calls or a pause/resume cycle.
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

        // Clamp to 0: withdrawn_amount should never exceed deposited_amount in
        // normal flow, but guard defensively so the function never returns negative.
        let remaining = stream
            .deposited_amount
            .saturating_sub(stream.withdrawn_amount)
            .max(0);

        match &stream.schedule {
            VestingSchedule::Linear => {
                let elapsed = effective_now.saturating_sub(stream.last_update_time);

                // Use checked_mul to prevent overflow when multiplying rate * elapsed.
                // If overflow would occur, cap at the remaining balance.
                let streamed = match (elapsed as i128).checked_mul(stream.rate_per_second) {
                    Some(result) => result,
                    None => return remaining,
                };

                streamed.min(remaining)
            }
            VestingSchedule::StepTranches(steps) => {
                let mut unlocked: i128 = 0;
                for step in steps.iter() {
                    // Strictly increasing unlock times make the early exit
                    // equivalent to a full scan, at O(reached steps).
                    if step.unlock_time > effective_now {
                        break;
                    }
                    unlocked = unlocked.saturating_add(step.unlock_amount);
                }
                unlocked
                    .saturating_sub(stream.withdrawn_amount)
                    .max(0)
                    .min(remaining)
            }
            VestingSchedule::HybridCliffLinear(cliff_time, cliff_unlock_amount) => {
                if effective_now < *cliff_time {
                    return 0;
                }
                // The linear tail is anchored at `cliff_time` and can never
                // outrun the post-cliff remainder, so a partial withdrawal can
                // never re-earn the tail it already consumed.
                let linear_total = stream.deposited_amount.saturating_sub(*cliff_unlock_amount);
                let linear_elapsed = effective_now.saturating_sub(*cliff_time);
                let linear = match (linear_elapsed as i128).checked_mul(stream.rate_per_second) {
                    Some(result) => result.min(linear_total),
                    None => linear_total,
                };
                (*cliff_unlock_amount)
                    .saturating_add(linear)
                    .saturating_sub(stream.withdrawn_amount)
                    .max(0)
                    .min(remaining)
            }
        }
    }

    /// Ledger timestamp at which a stream is expected to be fully drained.
    ///
    /// For [`VestingSchedule::Linear`] this is `last_update_time + remaining /
    /// rate`. For the linear tail of [`VestingSchedule::HybridCliffLinear`] the
    /// accrual is anchored at `cliff_time` instead, and the still-unclaimed
    /// cliff is excluded because it does not drip. Step-tranche streams have no
    /// rate at all and report the timestamp of their final unlock step, which is
    /// the only meaningful deadline they have.
    fn projected_end_time(stream: &Stream) -> u64 {
        let remaining = stream
            .deposited_amount
            .saturating_sub(stream.withdrawn_amount);

        let drip_time = |anchor: u64, drippable: i128| -> u64 {
            // A non-positive rate means there is no linear component left to
            // project; report the anchor rather than dividing by zero.
            if stream.rate_per_second <= 0 {
                return anchor;
            }
            anchor.saturating_add((drippable.max(0) / stream.rate_per_second) as u64)
        };

        match &stream.schedule {
            VestingSchedule::StepTranches(steps) => {
                let len = steps.len();
                if len == 0 {
                    return stream.last_update_time;
                }
                steps.get(len - 1).unwrap().unlock_time
            }
            VestingSchedule::HybridCliffLinear(cliff_time, cliff_unlock_amount) => {
                let unclaimed_cliff = cliff_unlock_amount.saturating_sub(stream.withdrawn_amount);
                drip_time(*cliff_time, remaining.saturating_sub(unclaimed_cliff))
            }
            VestingSchedule::Linear => {
                // `create_stream` guarantees rate >= 1 for linear streams, but
                // the guard above keeps a hand-crafted record from trapping.
                let anchor = match stream.paused_at {
                    Some(paused_at) => paused_at,
                    None => stream.last_update_time,
                };
                drip_time(anchor, remaining)
            }
        }
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
    ) {
        // Effects: update stream state
        stream.withdrawn_amount += amount;
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
            return Err(StreamError::StreamPaused);
        }

        let now = env.ledger().timestamp();
        let claimable = Self::calculate_claimable(&stream, now);

        if claimable <= 0 {
            return Err(StreamError::InvalidAmount);
        }

        // Apply withdrawal: updates state, persists to storage, then transfers (CEI)
        Self::apply_withdrawal(&env, &mut stream, stream_id, &recipient, claimable, now);

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
    /// Step-tranche schedules are anchored to absolute unlock timestamps and
    /// carry no rate, so their reported `new_end_time` is the final unlock step
    /// rather than a rate-derived projection. Note that pausing does *not* push
    /// a step deadline out: a step that fell due while the stream was paused is
    /// claimable as soon as it resumes.
    ///
    /// # Errors
    /// - `StreamNotFound`  — no stream exists with `stream_id`.
    /// - `Unauthorized`    — caller is not the stream's sender.
    /// - `StreamNotPaused` — stream is active but not currently paused.
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
        // Only meaningful for the rate-based schedules; the step engine ignores
        // this anchor entirely.
        stream.last_update_time = stream.last_update_time.saturating_add(pause_duration);
        // new_end_time represents when the stream will fully drain from now,
        // net of the amount already accrued (and claimable) at the pause point.
        let remaining = stream
            .deposited_amount
            .saturating_sub(stream.withdrawn_amount)
            .saturating_sub(claimable_at_resume);

        let new_end_time = match stream.schedule {
            // A linear stream is guaranteed rate >= 1 by create_stream's
            // InvalidRate guard, so the division is safe here.
            VestingSchedule::Linear => now + (remaining / stream.rate_per_second) as u64,
            // Step and hybrid schedules are anchored to absolute timestamps;
            // ask the schedule-aware projection instead of dividing.
            _ => {
                stream.paused = false;
                stream.paused_at = None;
                let projected = Self::projected_end_time(&stream);
                stream.paused = true;
                stream.paused_at = Some(paused_at);
                projected
            }
        };

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

    /// Withdraw claimable tokens from several streams in one transaction.
    ///
    /// A recipient with N concurrent income streams would otherwise need N
    /// ledger transactions — N base fees, N wallet signatures, and N chances
    /// for a sequence-number collision to leave them in a partially withdrawn
    /// state. This collapses the sweep into a single atomic call.
    ///
    /// Semantics, chosen so that one stale entry can never grief the rest of the
    /// batch:
    /// - **Hard errors abort the whole batch** — an unknown `stream_id`
    ///   (`StreamNotFound`) or a stream belonging to somebody else
    ///   (`Unauthorized`). A silently-ignored typo would be worse than a
    ///   revert, and the transaction is atomic either way.
    /// - **Streams with nothing to claim are skipped** — already-completed,
    ///   cancelled, sender-paused, or simply not vested far enough yet. They
    ///   appear in neither the returned vector nor the events, and they do not
    ///   revert the batch.
    ///
    /// Each processed stream emits its own `tokens_withdrawn` event, and any
    /// stream drained by this call also emits `stream_completed`, so an indexer
    /// sees exactly the same event stream it would from N separate `withdraw`
    /// calls. Streams may target different tokens; each is paid from its own
    /// token contract.
    ///
    /// This entrypoint intentionally remains available while the protocol
    /// circuit breaker is engaged: a pause must never block access to
    /// already-vested funds.
    ///
    /// # Errors
    /// - `BatchTooLarge`   — more than `MAX_BATCH_WITHDRAW` IDs supplied.
    /// - `StreamNotFound`  — an ID does not exist.
    /// - `Unauthorized`    — an ID belongs to a different recipient.
    pub fn batch_withdraw(
        env: Env,
        recipient: Address,
        stream_ids: Vec<u64>,
    ) -> Result<Vec<(u64, i128)>, StreamError> {
        recipient.require_auth();

        if stream_ids.len() > MAX_BATCH_WITHDRAW {
            return Err(StreamError::BatchTooLarge);
        }

        let now = env.ledger().timestamp();
        let mut withdrawn: Vec<(u64, i128)> = Vec::new(&env);

        for stream_id in stream_ids.iter() {
            let mut stream = load_stream(&env, stream_id)?;

            if stream.recipient != recipient {
                return Err(StreamError::Unauthorized);
            }

            // Nothing to claim: already finished, or frozen by its own sender.
            if !stream.is_active || stream.paused {
                continue;
            }

            let claimable = Self::calculate_claimable(&stream, now);
            if claimable <= 0 {
                continue;
            }

            // Each stream is committed to storage before its own token transfer
            // (CEI), so a malicious token cannot re-enter against stale state.
            Self::apply_withdrawal(&env, &mut stream, stream_id, &recipient, claimable, now);

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

            if completed {
                env.events().publish(
                    (Symbol::new(&env, "stream_completed"), stream_id),
                    StreamCompletedEvent {
                        stream_id,
                        recipient: recipient.clone(),
                        total_withdrawn: stream.withdrawn_amount,
                    },
                );
            }

            withdrawn.push_back((stream_id, claimable));
        }

        Ok(withdrawn)
    }

    // ─── Upgrades & State Migration (F3) ──────────────────────────────────────

    /// Replace this contract's executable in place, preserving its address.
    ///
    /// The admin must authenticate. The new module must already be present on
    /// the ledger; upload it with `env.deployer().upload_contract_wasm(..)` and
    /// pass the resulting hash here.
    ///
    /// Because the address never changes, active streams, escrowed balances and
    /// the protocol config all survive untouched — which is the entire reason to
    /// prefer an in-place upgrade over a redeploy. Note that swapping the
    /// executable does **not** migrate state: if the new code expects a
    /// different schema, follow up with `migrate`.
    ///
    /// All storage writes and the `contract_upgraded` event happen *before* the
    /// swap, because the host finalizes the new executable as this invocation
    /// returns and rejects further contract-side writes afterwards.
    ///
    /// `old_wasm_hash` is read from `DataKey::ContractWasmHash` rather than from
    /// the host, which exposes no getter for a contract's live executable. It is
    /// therefore all-zero for a contract that has never been upgraded.
    ///
    /// # Errors
    /// - `NotInitialized` — `initialize` has not been called.
    /// - `NotAdmin`       — caller is not the current admin.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), StreamError> {
        let config = load_config(&env)?;
        config.admin.require_auth();

        env.events().publish(
            (Symbol::new(&env, "contract_upgraded"),),
            ContractUpgradedEvent {
                admin: config.admin,
                old_wasm_hash: get_recorded_wasm_hash(&env),
                new_wasm_hash: new_wasm_hash.clone(),
                timestamp: env.ledger().timestamp(),
            },
        );

        save_recorded_wasm_hash(&env, &new_wasm_hash);
        env.deployer().update_current_contract_wasm(new_wasm_hash);

        Ok(())
    }

    /// Returns the on-chain state schema version.
    ///
    /// `0` means the state predates versioning and still uses the legacy
    /// layout; see `migrate`.
    pub fn get_contract_version(env: Env) -> u32 {
        get_contract_version(&env)
    }

    /// Move the on-chain state to `target_version`. Admin-only.
    ///
    /// Only forward moves are supported, and only to the version this contract
    /// knows how to write. Today that is a single step — any pre-v2 state
    /// (`0` unversioned, or `1` versioned) becomes `2`, the layout carrying the
    /// circuit breaker, the guardian role and the `VestingSchedule`
    /// discriminator.
    ///
    /// Streams are migrated lazily rather than in bulk: Soroban exposes no way
    /// to enumerate persistent storage, so a sweep is impossible. Instead both
    /// `load_config` and `load_stream` decode the legacy shape on read and
    /// rewrite the record in the current shape the next time it is written. A
    /// migrated record therefore heals on first touch.
    ///
    /// Idempotent: migrating to the version already in effect is a no-op.
    ///
    /// # Errors
    /// - `NotInitialized`      — `initialize` has not been called.
    /// - `NotAdmin`            — caller is not the current admin.
    /// - `StateVersionTooNew`  — on-chain state is newer than this contract.
    /// - `UnsupportedMigration` — the target version is unreachable or a downgrade.
    pub fn migrate(env: Env, target_version: u32) -> Result<(), StreamError> {
        let config = load_config(&env)?;
        config.admin.require_auth();

        let current_version = get_contract_version(&env);

        if current_version > CURRENT_DATA_VERSION {
            return Err(StreamError::StateVersionTooNew);
        }
        if target_version > CURRENT_DATA_VERSION || target_version < current_version {
            return Err(StreamError::UnsupportedMigration);
        }
        if target_version == current_version {
            return Ok(());
        }

        // `load_config` already decoded (and defaulted) a legacy record, so
        // rewriting it here is what actually persists the new shape.
        save_config(&env, &config);
        save_contract_version(&env, target_version);

        env.events().publish(
            (Symbol::new(&env, "state_migrated"),),
            StateMigratedEvent {
                admin: config.admin,
                old_version: current_version,
                new_version: target_version,
            },
        );

        Ok(())
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

    /// Returns the unlock curve governing a stream, or `None` if it is unknown.
    ///
    /// Callers building a vesting UI need the step list itself, not just the
    /// aggregate claimable figure.
    pub fn get_vesting_schedule(env: Env, stream_id: u64) -> Option<VestingSchedule> {
        try_load_stream(&env, stream_id).map(|stream| stream.schedule)
    }

    /// Returns the ledger timestamp at which a stream is projected to drain.
    ///
    /// Step-tranche streams report their final unlock step; rate-based streams
    /// report the linear projection. Returns `None` for an unknown stream.
    pub fn get_projected_end_time(env: Env, stream_id: u64) -> Option<u64> {
        try_load_stream(&env, stream_id).map(|stream| Self::projected_end_time(&stream))
    }

    // ─── Internal Helpers ─────────────────────────────────────────────────────

    /// Deducts the protocol fee from `amount`, transfers it to the treasury,
    /// emits a `fee_collected` event, and returns the net amount.
    ///
    /// If no protocol config exists or the fee rate is 0, returns `amount` unchanged.
    /// If fee calculation truncates to 0, no transfer/event occurs and `amount` is unchanged.
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
