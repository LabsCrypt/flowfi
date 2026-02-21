#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

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
