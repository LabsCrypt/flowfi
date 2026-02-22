#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, contracterror, Address, Env, Symbol, symbol_short, token};





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

// Event definitions for indexing
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

pub fn calculate_claimable(stream: &Stream, now: u64) -> Result<i128, StreamError> {
    // If stream inactive, nothing claimable
    if !stream.is_active {
        return Err(StreamError::StreamInactive);
    }

    // No time passed
    if now <= stream.last_update_time {
        return Ok(0);
    }

    // Safe time difference
    let elapsed = now
        .checked_sub(stream.last_update_time)
        .ok_or(StreamError::InvalidAmount)? as i128;

    // Safe multiplication (overflow protected)
    let accrued = elapsed
        .checked_mul(stream.rate_per_second)
        .ok_or(StreamError::InvalidAmount)?;

    // Remaining available balance
    let available = stream
        .deposited_amount
        .checked_sub(stream.withdrawn_amount)
        .ok_or(StreamError::InvalidAmount)?;

    // Cannot withdraw more than deposited
    Ok(accrued.min(available))
}

#[contracttype]
pub enum DataKey {
    StreamCounter,
    Stream(u64),
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
        // Placeholder for stream creation logic
        // 1. Transfer tokens to contract
        // 2. Store stream state

        // Generate stream ID (placeholder - use proper counter in production)
        let stream_id: u64 = env.ledger().sequence() as u64;
        let start_time = env.ledger().timestamp();

        // Emit StreamCreated event
        env.events().publish(
            (Symbol::new(&env, "stream_created"), stream_id),
            StreamCreatedEvent {
                stream_id,
                sender: sender.clone(),
                recipient: recipient.clone(),
                rate: amount,
                token_address: token_address.clone(),
                start_time,
            }
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
     
      pub fn withdraw(env: Env, recipient: Address, stream_id: u64)
     {
        // Placeholder for withdraw logic
        // 1. Calculate claimable amount based on time delta
        // 2. Transfer tokens to recipient
        // 3. Update stream state

        // Placeholder amount calculation
        let amount: i128 = 0; // Calculate actual amount in production
        let timestamp = env.ledger().timestamp();

        // Emit TokensWithdrawn event
        env.events().publish(
            (Symbol::new(&env, "tokens_withdrawn"), stream_id),
            TokensWithdrawnEvent {
                stream_id,
                recipient: recipient.clone(),
                amount,
                timestamp,
            }
        );
    }

    pub fn cancel_stream(env: Env, sender: Address, stream_id: u64) {
        sender.require_auth();
        // Placeholder for cancel logic
        // 1. Calculate amount already withdrawn
        // 2. Return remaining tokens to sender
        // 3. Mark stream as cancelled

        // Placeholder values
        let recipient = sender.clone(); // Get actual recipient from storage in production
        let amount_withdrawn: i128 = 0; // Calculate actual amount in production

        // Emit StreamCancelled event
        env.events().publish(
            (Symbol::new(&env, "stream_cancelled"), stream_id),
            StreamCancelledEvent {
                stream_id,
                sender: sender.clone(),
                recipient,
                amount_withdrawn,
            }
        );
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

  
    pub fn get_stream(env: Env, stream_id: u64) -> Option<Stream> {
        env.storage().instance().get(&DataKey::Stream(stream_id))
    }
}

mod test;
