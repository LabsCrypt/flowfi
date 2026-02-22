#![cfg(test)]

use super::*;
use soroban_sdk::{Env, testutils::Address as _, Address, token, symbol_short};

#[test]
fn test_create_stream() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_address, _admin) = create_token_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let stellar_asset = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
    stellar_asset.mint(&sender, &1000);

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let token_client = soroban_sdk::token::Client::new(&env, &token_address);
    token_client.approve(&sender, &contract_id, &500, &1000000);

    let amount: i128 = 500;
    let duration: u64 = 86400;

    let stream_id = client.create_stream(&sender, &recipient, &token_address, &amount, &duration);

    assert_eq!(stream_id, 1);

    let stream = client.get_stream(&stream_id);
    assert!(stream.is_some());
    let stream = stream.unwrap();
    assert_eq!(stream.sender, sender);
    assert_eq!(stream.recipient, recipient);
    assert_eq!(stream.rate, amount);
    assert_eq!(stream.token_address, token_address);
    assert_eq!(stream.duration, duration);
    assert_eq!(stream.withdrawn, 0);
}

#[test]
fn test_create_multiple_streams() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_address, _admin) = create_token_contract(&env);
    let sender = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    let stellar_asset = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
    stellar_asset.mint(&sender, &2000);

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let token_client = soroban_sdk::token::Client::new(&env, &token_address);
    token_client.approve(&sender, &contract_id, &1000, &1000000);

    let stream_id1 = client.create_stream(&sender, &recipient1, &token_address, &500, &86400);
    let stream_id2 = client.create_stream(&sender, &recipient2, &token_address, &500, &86400);

    assert_eq!(stream_id1, 1);
    assert_eq!(stream_id2, 2);
}

#[test]
fn test_create_stream_transfers_tokens() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_address, _admin) = create_token_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let stellar_asset = soroban_sdk::token::StellarAssetClient::new(&env, &token_address);
    stellar_asset.mint(&sender, &1000);

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);
    let token_client = soroban_sdk::token::Client::new(&env, &token_address);

    let initial_sender_balance = token_client.balance(&sender);
    let initial_contract_balance = token_client.balance(&contract_id);

    token_client.approve(&sender, &contract_id, &500, &1000000);

    let amount: i128 = 500;
    let duration: u64 = 86400;

    client.create_stream(&sender, &recipient, &token_address, &amount, &duration);

    assert_eq!(
        token_client.balance(&sender),
        initial_sender_balance - amount
    );
    assert_eq!(
        token_client.balance(&contract_id),
        initial_contract_balance + amount
    );
}

#[test]
fn test_top_up_stream_success() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    // Create mock addresses
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env);

    // Deploy a mock token contract
    let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_address = token_contract.address();
    let token_client = token::StellarAssetClient::new(&env, &token_address);

    // Mint initial tokens to sender
    token_client.mint(&sender, &1_000_000);

    // Manually create a stream in storage (since create_stream is not fully implemented)
    let stream = Stream {
        sender: sender.clone(),
        recipient: recipient.clone(),
        token_address: token_address.clone(),
        rate_per_second: 100,
        deposited_amount: 10_000,
        withdrawn_amount: 0,
        start_time: env.ledger().timestamp(),
        last_update_time: env.ledger().timestamp(),
        is_active: true,
    };

    let stream_id = 1u64;
    env.as_contract(&contract_id, || {
        let storage = env.storage().persistent();
        storage.set(&(symbol_short!("STREAMS"), stream_id), &stream);
    });

    // Top up the stream with additional funds
    let top_up_amount = 5_000i128;
    let result = client.try_top_up_stream(&sender, &stream_id, &top_up_amount);
    assert!(result.is_ok());

    // Verify the stream was updated
    env.as_contract(&contract_id, || {
        let storage = env.storage().persistent();
        let updated_stream: Stream = storage.get(&(symbol_short!("STREAMS"), stream_id)).unwrap();
        assert_eq!(updated_stream.deposited_amount, 15_000);
    });
}

#[test]
fn test_top_up_stream_invalid_amount() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let sender = Address::generate(&env);
    let stream_id = 1u64;

    // Try to top up with negative amount
    let result = client.try_top_up_stream(&sender, &stream_id, &(-100i128));
    assert_eq!(result, Err(Ok(StreamError::InvalidAmount)));

    // Try to top up with zero amount
    let result = client.try_top_up_stream(&sender, &stream_id, &0i128);
    assert_eq!(result, Err(Ok(StreamError::InvalidAmount)));
}

#[test]
fn test_top_up_stream_not_found() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let sender = Address::generate(&env);
    let stream_id = 999u64; // Non-existent stream

    let result = client.try_top_up_stream(&sender, &stream_id, &1_000i128);
    assert_eq!(result, Err(Ok(StreamError::StreamNotFound)));
}

#[test]
fn test_top_up_stream_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let sender = Address::generate(&env);
    let different_sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_address = token_contract.address();

    // Create a stream with original sender
    let stream = Stream {
        sender: sender.clone(),
        recipient: recipient.clone(),
        token_address: token_address.clone(),
        rate_per_second: 100,
        deposited_amount: 10_000,
        withdrawn_amount: 0,
        start_time: env.ledger().timestamp(),
        last_update_time: env.ledger().timestamp(),
        is_active: true,
    };

    let stream_id = 1u64;
    env.as_contract(&contract_id, || {
        let storage = env.storage().persistent();
        storage.set(&(symbol_short!("STREAMS"), stream_id), &stream);
    });

    // Try to top up with different sender
    let result = client.try_top_up_stream(&different_sender, &stream_id, &1_000i128);
    assert_eq!(result, Err(Ok(StreamError::Unauthorized)));
}

#[test]
fn test_top_up_stream_inactive() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_address = token_contract.address();

    // Create an inactive stream
    let stream = Stream {
        sender: sender.clone(),
        recipient: recipient.clone(),
        token_address: token_address.clone(),
        rate_per_second: 100,
        deposited_amount: 10_000,
        withdrawn_amount: 0,
        start_time: env.ledger().timestamp(),
        last_update_time: env.ledger().timestamp(),
        is_active: false, // Inactive stream
    };

    let stream_id = 1u64;
    env.as_contract(&contract_id, || {
        let storage = env.storage().persistent();
        storage.set(&(symbol_short!("STREAMS"), stream_id), &stream);
    });

    // Try to top up inactive stream
    let result = client.try_top_up_stream(&sender, &stream_id, &1_000i128);
    assert_eq!(result, Err(Ok(StreamError::StreamInactive)));
}

    
#[test]
fn test_calculate_claimable() {
    let env = Env::default();

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token = Address::generate(&env);

    let stream = Stream {
        sender,
        recipient,
        token_address: token,
        rate_per_second: 10,
        deposited_amount: 1000,
        withdrawn_amount: 0,
        start_time: 0,
        last_update_time: 0,
        is_active: true,
    };

    let result = calculate_claimable(&stream, 50).unwrap();

    assert_eq!(result, 500); // 50 * 10
}




