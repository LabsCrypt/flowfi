#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, token, Address, Env};

fn create_token_contract(env: &Env) -> (Address, Address) {
    let admin = Address::generate(env);
    let token_contract = env.register_stellar_asset_contract_v2(admin.clone());
    (token_contract.address(), admin)
}

#[test]
fn test_create_stream() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_address, _admin) = create_token_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let stellar_asset = token::StellarAssetClient::new(&env, &token_address);
    stellar_asset.mint(&sender, &1000);

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let amount: i128 = 500;
    let duration: u64 = 100;

    let stream_id = client.create_stream(&sender, &recipient, &token_address, &amount, &duration);

    assert_eq!(stream_id, 1);

    let stream = client.get_stream(&stream_id).unwrap();
    assert_eq!(stream.sender, sender);
    assert_eq!(stream.recipient, recipient);
    assert_eq!(stream.token_address, token_address);
    assert_eq!(stream.rate_per_second, amount / duration as i128);
    assert_eq!(stream.deposited_amount, amount);
    assert_eq!(stream.withdrawn_amount, 0);
    assert!(stream.is_active);
}

#[test]
fn test_create_multiple_streams() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_address, _admin) = create_token_contract(&env);
    let sender = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    let stellar_asset = token::StellarAssetClient::new(&env, &token_address);
    stellar_asset.mint(&sender, &2000);

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let stream_id1 = client.create_stream(&sender, &recipient1, &token_address, &500, &100);
    let stream_id2 = client.create_stream(&sender, &recipient2, &token_address, &500, &100);

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

    let stellar_asset = token::StellarAssetClient::new(&env, &token_address);
    stellar_asset.mint(&sender, &1000);

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);
    let token_client = token::Client::new(&env, &token_address);

    let initial_sender_balance = token_client.balance(&sender);
    let initial_contract_balance = token_client.balance(&contract_id);

    let amount: i128 = 500;
    let duration: u64 = 100;

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

    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_admin = Address::generate(&env);

    let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_address = token_contract.address();
    let token_client = token::StellarAssetClient::new(&env, &token_address);

    token_client.mint(&sender, &1_000_000);

    let stream = Stream {
        sender: sender.clone(),
        recipient,
        token_address,
        rate_per_second: 100,
        deposited_amount: 10_000,
        withdrawn_amount: 0,
        start_time: env.ledger().timestamp(),
        last_update_time: env.ledger().timestamp(),
        is_active: true,
    };

    let stream_id = 1u64;
    env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::Stream(stream_id), &stream);
    });

    let top_up_amount = 5_000i128;
    let result = client.try_top_up_stream(&sender, &stream_id, &top_up_amount);
    assert!(result.is_ok());

    let updated_stream = client.get_stream(&stream_id).unwrap();
    assert_eq!(updated_stream.deposited_amount, 15_000);
}

#[test]
fn test_top_up_stream_invalid_amount() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let sender = Address::generate(&env);
    let stream_id = 1u64;

    let result = client.try_top_up_stream(&sender, &stream_id, &(-100i128));
    assert_eq!(result, Err(Ok(StreamError::InvalidAmount)));

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
    let stream_id = 999u64;

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

    let stream = Stream {
        sender: sender.clone(),
        recipient,
        token_address,
        rate_per_second: 100,
        deposited_amount: 10_000,
        withdrawn_amount: 0,
        start_time: env.ledger().timestamp(),
        last_update_time: env.ledger().timestamp(),
        is_active: true,
    };

    let stream_id = 1u64;
    env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::Stream(stream_id), &stream);
    });

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

    let stream = Stream {
        sender: sender.clone(),
        recipient,
        token_address,
        rate_per_second: 100,
        deposited_amount: 10_000,
        withdrawn_amount: 0,
        start_time: env.ledger().timestamp(),
        last_update_time: env.ledger().timestamp(),
        is_active: false,
    };

    let stream_id = 1u64;
    env.as_contract(&contract_id, || {
        env.storage()
            .persistent()
            .set(&DataKey::Stream(stream_id), &stream);
    });

    let result = client.try_top_up_stream(&sender, &stream_id, &1_000i128);
    assert_eq!(result, Err(Ok(StreamError::StreamInactive)));
}
