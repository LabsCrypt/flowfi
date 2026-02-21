#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, contracterror, Address, Env, symbol_short, token};

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

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum StreamError {
    InvalidAmount = 1,
    StreamNotFound = 2,
    Unauthorized = 3,
    StreamInactive = 4,
}

#[contract]
pub struct StreamContract;

#[contractimpl]
impl StreamContract {
    pub fn create_stream(env: Env, sender: Address, recipient: Address, rate: i128, token_address: Address) {
        sender.require_auth();
        // Placeholder for stream creation logic
        // 1. Transfer tokens to contract
        // 2. Store stream state
    }

    pub fn withdraw(env: Env, recipient: Address, stream_id: u64) {
        recipient.require_auth();
        // Placeholder for withdraw logic
        // 1. Calculate claimable amount based on time delta
        // 2. Transfer tokens to recipient
        // 3. Update stream state
    }

    /// Allows the sender to add more funds to an existing stream
    /// This extends the duration of the stream without creating a new one
    pub fn top_up_stream(env: Env, sender: Address, stream_id: u64, amount: i128) -> Result<(), StreamError> {
        // Require sender authentication
        sender.require_auth();

        // Validate amount is positive
        if amount <= 0 {
            return Err(StreamError::InvalidAmount);
        }

        // Get the stream from storage
        let storage = env.storage().persistent();
        let stream_key = (symbol_short!("STREAMS"), stream_id);

        let mut stream: Stream = match storage.get(&stream_key) {
            Some(s) => s,
            None => return Err(StreamError::StreamNotFound),
        };

        // Verify the caller is the original sender
        if stream.sender != sender {
            return Err(StreamError::Unauthorized);
        }

        // Verify stream is still active
        if !stream.is_active {
            return Err(StreamError::StreamInactive);
        }

        // Transfer tokens from sender to contract
        let token_client = token::Client::new(&env, &stream.token_address);
        let contract_address = env.current_contract_address();
        token_client.transfer(&sender, &contract_address, &amount);

        // Update stream state with additional deposit
        stream.deposited_amount += amount;
        stream.last_update_time = env.ledger().timestamp();

        // Save updated stream back to storage
        storage.set(&stream_key, &stream);

        Ok(())
    }
}

mod test;
