#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol, symbol_short, token};

// Event definitions for indexing
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCreatedEvent {
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
    pub rate: i128,
    pub token_address: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StreamCancelledEvent {
    pub stream_id: u64,
    pub sender: Address,
    pub recipient: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TokensWithdrawnEvent {
    pub stream_id: u64,
    pub recipient: Address,
    pub amount: i128,
}

#[contract]
pub struct StreamContract;

#[contractimpl]
impl StreamContract {
    pub fn create_stream(env: Env, sender: Address, recipient: Address, rate: i128, token_address: Address, stream_id: u64) {
        sender.require_auth();
        // Placeholder for stream creation logic
        // 1. Transfer tokens to contract
        // 2. Store stream state

        // Emit StreamCreated event
        env.events().publish(
            (symbol_short!("created"),),
            StreamCreatedEvent {
                stream_id,
                sender: sender.clone(),
                recipient: recipient.clone(),
                rate,
                token_address: token_address.clone(),
            }
        );
    }

    pub fn cancel_stream(env: Env, sender: Address, stream_id: u64, recipient: Address) {
        sender.require_auth();
        // Placeholder for cancel logic
        // 1. Calculate remaining balance
        // 2. Return tokens to sender
        // 3. Remove stream state

        // Emit StreamCancelled event
        env.events().publish(
            (symbol_short!("cancelled"),),
            StreamCancelledEvent {
                stream_id,
                sender: sender.clone(),
                recipient: recipient.clone(),
            }
        );
    }

    pub fn withdraw(env: Env, recipient: Address, stream_id: u64) {
        recipient.require_auth();
        // Placeholder for withdraw logic
        // 1. Calculate claimable amount based on time delta
        let amount: i128 = 0; // Placeholder calculation
        // 2. Transfer tokens to recipient
        // 3. Update stream state

        // Emit TokensWithdrawn event
        env.events().publish(
            (symbol_short!("withdrawn"),),
            TokensWithdrawnEvent {
                stream_id,
                recipient: recipient.clone(),
                amount,
            }
        );
    }
}

mod test;
