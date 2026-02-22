#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Env, Symbol,
};

#[derive(Clone)]
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

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Stream(u64),
    StreamCounter,
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

        let stream_id = Self::get_next_stream_id(&env);
        let start_time = env.ledger().timestamp();

        let token_client = token::Client::new(&env, &token_address);
        let contract_address = env.current_contract_address();
        token_client.transfer(&sender, &contract_address, &amount);

        let rate_per_second = if duration == 0 {
            amount
        } else {
            amount / duration as i128
        };

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

    pub fn withdraw(env: Env, recipient: Address, stream_id: u64) {
        recipient.require_auth();

        let amount = 0_i128;
        let timestamp = env.ledger().timestamp();

        env.events().publish(
            (Symbol::new(&env, "tokens_withdrawn"), stream_id),
            TokensWithdrawnEvent {
                stream_id,
                recipient,
                amount,
                timestamp,
            },
        );
    }

    pub fn cancel_stream(env: Env, sender: Address, stream_id: u64) {
        sender.require_auth();

        let key = DataKey::Stream(stream_id);
        let storage = env.storage().persistent();
        let mut stream: Stream = match storage.get(&key) {
            Some(s) => s,
            None => return,
        };

        if stream.sender != sender {
            return;
        }

        stream.is_active = false;
        storage.set(&key, &stream);

        env.events().publish(
            (Symbol::new(&env, "stream_cancelled"), stream_id),
            StreamCancelledEvent {
                stream_id,
                sender,
                recipient: stream.recipient,
                amount_withdrawn: stream.withdrawn_amount,
            },
        );
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
        let key = DataKey::Stream(stream_id);

        let mut stream: Stream = match storage.get(&key) {
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

        storage.set(&key, &stream);

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
