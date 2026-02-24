#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, token, Address, Env,
    Symbol,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Stream(u64),
    StreamCounter,
    ProtocolConfig,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Stream {
    pub sender: Address,
    pub recipient: Address,
    pub token_address: Address,
    pub rate_per_second: i128,
    pub deposited_amount: i128,
    pub withdrawn_amount: i128,
    pub start_time: u64,
    pub last_update_time: u64,
    pub is_active: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolConfig {
    pub admin: Address,
    pub treasury: Address,
    pub fee_rate_bps: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum StreamError {
    InvalidAmount = 1,
    StreamNotFound = 2,
    Unauthorized = 3,
    StreamInactive = 4,
    AlreadyInitialized = 5,
    NotAdmin = 6,
    InvalidFeeRate = 7,
    NotInitialized = 8,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCreatedEvent {
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub rate: i128,
    pub token_address: Address,
    pub start_time: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCancelledEvent {
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub amount_withdrawn: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokensWithdrawnEvent {
    pub stream_id: u64,
    pub recipient: Address,
    pub amount: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamToppedUpEvent {
    pub stream_id: u64,
    pub sender: Address,
    pub amount: i128,
    pub new_deposited_amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeCollectedEvent {
    pub stream_id: u64,
    pub treasury: Address,
    pub fee_amount: i128,
    pub token: Address,
}

#[contract]
pub struct StreamContract;

/// Maximum fee rate: 1000 basis points = 10%
const MAX_FEE_RATE_BPS: u32 = 1_000;

#[contractimpl]
impl StreamContract {
    // ─── Admin: Protocol Fee Configuration ───────────────────────────

    /// One-time initialization of the protocol fee config.
    /// Sets the admin, treasury address, and fee rate (in basis points).
    pub fn initialize(
        env: Env,
        admin: Address,
        treasury: Address,
        fee_rate_bps: u32,
    ) -> Result<(), StreamError> {
        admin.require_auth();

        if env
            .storage()
            .instance()
            .has(&DataKey::ProtocolConfig)
        {
            return Err(StreamError::AlreadyInitialized);
        }

        if fee_rate_bps > MAX_FEE_RATE_BPS {
            return Err(StreamError::InvalidFeeRate);
        }

        let config = ProtocolConfig {
            admin,
            treasury,
            fee_rate_bps,
        };
        env.storage()
            .instance()
            .set(&DataKey::ProtocolConfig, &config);

        Ok(())
    }

    /// Update the treasury address and/or fee rate. Admin-only.
    pub fn update_fee_config(
        env: Env,
        admin: Address,
        treasury: Address,
        fee_rate_bps: u32,
    ) -> Result<(), StreamError> {
        admin.require_auth();

        let config: ProtocolConfig = env
            .storage()
            .instance()
            .get(&DataKey::ProtocolConfig)
            .ok_or(StreamError::NotInitialized)?;

        if config.admin != admin {
            return Err(StreamError::NotAdmin);
        }

        if fee_rate_bps > MAX_FEE_RATE_BPS {
            return Err(StreamError::InvalidFeeRate);
        }

        let new_config = ProtocolConfig {
            admin: config.admin,
            treasury,
            fee_rate_bps,
        };
        env.storage()
            .instance()
            .set(&DataKey::ProtocolConfig, &new_config);

        Ok(())
    }

    /// Read the current protocol fee configuration (returns None if not initialized).
    pub fn get_fee_config(env: Env) -> Option<ProtocolConfig> {
        env.storage()
            .instance()
            .get(&DataKey::ProtocolConfig)
    }

    // ─── Fee Collection ──────────────────────────────────────────────

    /// Deducts protocol fee from `amount` and transfers it to the treasury.
    /// Returns the net amount (amount - fee). If no config or fee is 0, returns `amount` unchanged.
    fn collect_fee(
        env: &Env,
        token_address: &Address,
        amount: i128,
        stream_id: u64,
    ) -> i128 {
        let config: Option<ProtocolConfig> = env
            .storage()
            .instance()
            .get(&DataKey::ProtocolConfig);

        match config {
            Some(cfg) if cfg.fee_rate_bps > 0 => {
                let fee = amount * (cfg.fee_rate_bps as i128) / 10_000;
                if fee > 0 {
                    let token_client = token::Client::new(env, token_address);
                    let contract_address = env.current_contract_address();
                    token_client.transfer(&contract_address, &cfg.treasury, &fee);

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

    // ─── Stream Operations ───────────────────────────────────────────

    pub fn create_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token_address: Address,
        amount: i128,
        duration: u64,
    ) -> u64 {
        sender.require_auth();

        if Self::is_emergency_mode(env.clone()) {
            panic_with_error!(&env, StreamError::EmergencyStopEnabled);
        }

        if amount <= 0 || duration == 0 {
            panic_with_error!(&env, StreamError::InvalidAmount);
        }

        let stream_id = Self::get_next_stream_id(&env);
        let start_time = env.ledger().timestamp();

        // Transfer full amount from sender to contract
        let token_client = token::Client::new(&env, &token_address);
        let contract_address = env.current_contract_address();
        token_client.transfer(&sender, &contract_address, &amount);

        // Deduct protocol fee (if configured) and get net amount for the stream
        let net_amount = Self::collect_fee(&env, &token_address, amount, stream_id);
        let rate_per_second = net_amount / (duration as i128);

        let stream = Stream {
            sender: sender.clone(),
            recipient: recipient.clone(),
            token_address: token_address.clone(),
            rate_per_second,
            deposited_amount: net_amount,
            withdrawn_amount: 0,
            start_time,
            last_update_time: start_time,
            is_active: true,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Stream(stream_id), &stream);

        env.events().publish(
            (Symbol::new(&env, "stream_created"), stream_id),
            StreamCreatedEvent {
                stream_id,
                sender,
                recipient,
                rate: rate_per_second,
                token_address,
                start_time,
            },
        );

        stream_id
    }

    fn get_next_stream_id(env: &Env) -> u64 {
        let counter: u64 = env
            .storage()
            .instance()
            .get(&DataKey::StreamCounter)
            .unwrap_or(0);
        let next_id = counter + 1;
        env.storage()
            .instance()
            .set(&DataKey::StreamCounter, &next_id);
        next_id
    }

    pub fn withdraw(env: Env, recipient: Address, stream_id: u64) -> Result<i128, StreamError> {
        recipient.require_auth();

        let storage = env.storage().persistent();
        let stream_key = DataKey::Stream(stream_id);

        let mut stream: Stream = match storage.get(&stream_key) {
            Some(s) => s,
            None => return Err(StreamError::StreamNotFound),
        };

        if stream.recipient != recipient {
            return Err(StreamError::Unauthorized);
        }

        if !stream.is_active {
            return Err(StreamError::StreamInactive);
        }

        let claimable = stream.deposited_amount - stream.withdrawn_amount;
        if claimable <= 0 {
            return Err(StreamError::InvalidAmount);
        }

        let token_client = token::Client::new(&env, &stream.token_address);
        let contract_address = env.current_contract_address();
        token_client.transfer(&contract_address, &recipient, &claimable);

        stream.withdrawn_amount += claimable;
        stream.last_update_time = env.ledger().timestamp();
        if stream.withdrawn_amount >= stream.deposited_amount {
            stream.is_active = false;
        }
        storage.set(&stream_key, &stream);

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

    pub fn cancel_stream(env: Env, sender: Address, stream_id: u64) -> Result<(), StreamError> {
        sender.require_auth();

        let storage = env.storage().persistent();
        let stream_key = DataKey::Stream(stream_id);

        let mut stream: Stream = match storage.get(&stream_key) {
            Some(s) => s,
            None => return Err(StreamError::StreamNotFound),
        };

        if stream.sender != sender {
            return Err(StreamError::Unauthorized);
        }

        if !stream.is_active {
            return Err(StreamError::StreamInactive);
        }

        stream.is_active = false;
        stream.last_update_time = env.ledger().timestamp();
        let recipient = stream.recipient.clone();
        let amount_withdrawn = stream.withdrawn_amount;
        storage.set(&stream_key, &stream);

        env.events().publish(
            (Symbol::new(&env, "stream_cancelled"), stream_id),
            StreamCancelledEvent {
                stream_id,
                sender,
                recipient,
                amount_withdrawn,
            },
        );

        Ok(())
    }

    pub fn top_up_stream(
        env: Env,
        sender: Address,
        stream_id: u64,
        amount: i128,
    ) -> Result<(), StreamError> {
        sender.require_auth();

        if Self::is_emergency_mode(env.clone()) {
            return Err(StreamError::EmergencyStopEnabled);
        }

        if amount <= 0 {
            return Err(StreamError::InvalidAmount);
        }

        let storage = env.storage().persistent();
        let stream_key = DataKey::Stream(stream_id);

        let mut stream: Stream = match storage.get(&stream_key) {
            Some(s) => s,
            None => return Err(StreamError::StreamNotFound),
        };

        if stream.sender != sender {
            return Err(StreamError::Unauthorized);
        }

        if !stream.is_active {
            return Err(StreamError::StreamInactive);
        }

        // Transfer full amount from sender to contract
        let token_client = token::Client::new(&env, &stream.token_address);
        let contract_address = env.current_contract_address();
        token_client.transfer(&sender, &contract_address, &amount);

        // Deduct protocol fee (if configured) and add net amount to stream
        let net_amount = Self::collect_fee(&env, &stream.token_address, amount, stream_id);

        stream.deposited_amount += net_amount;
        stream.last_update_time = env.ledger().timestamp();

        storage.set(&stream_key, &stream);

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

    pub fn get_stream(env: Env, stream_id: u64) -> Option<Stream> {
        env.storage().persistent().get(&DataKey::Stream(stream_id))
    }
}

mod test;
