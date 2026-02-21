#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol};

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

#[contract]
pub struct StreamContract;

#[contractimpl]
impl StreamContract {
    pub fn create_stream(env: Env, sender: Address, recipient: Address, rate: i128, token_address: Address) {
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
                rate,
                token_address: token_address.clone(),
                start_time,
            }
        );
    }

    pub fn withdraw(env: Env, recipient: Address, stream_id: u64) {
        recipient.require_auth();
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
}

mod test;
