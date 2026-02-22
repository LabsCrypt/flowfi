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

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum StreamError {
    InvalidAmount = 1,
    StreamNotFound = 2,
    Unauthorized = 3,
    StreamInactive = 4,
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

#[contract]
pub struct StreamContract;

#[contractimpl]
impl StreamContract {
    pub fn create_stream(
        env: Env,
        sender: Address,
        recipient: Address,
        token_address: Address,
        amount: i128,
        duration: u64,
    ) -> u64 {
        sender.require_auth();

        if amount <= 0 || duration == 0 {
            panic_with_error!(&env, StreamError::InvalidAmount);
        }

        let stream_id = Self::get_next_stream_id(&env);
        let start_time = env.ledger().timestamp();
        let rate_per_second = amount / (duration as i128);

        let token_client = token::Client::new(&env, &token_address);
        let contract_address = env.current_contract_address();
        token_client.transfer(&sender, &contract_address, &amount);

        let stream = Stream {
            sender: sender.clone(),
            recipient: recipient.clone(),
            token_address: token_address.clone(),
            rate_per_second,
            deposited_amount: amount,
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

        let token_client = token::Client::new(&env, &stream.token_address);
        let contract_address = env.current_contract_address();
        token_client.transfer(&sender, &contract_address, &amount);

        stream.deposited_amount += amount;
        stream.last_update_time = env.ledger().timestamp();

        storage.set(&stream_key, &stream);

        env.events().publish(
            (Symbol::new(&env, "stream_topped_up"), stream_id),
            StreamToppedUpEvent {
                stream_id,
                sender,
                amount,
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
