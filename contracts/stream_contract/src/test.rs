#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, token, xdr, Address, Env, Symbol, TryFromVal};

fn create_token_contract(env: &Env) -> (Address, Address) {
    let admin = Address::generate(env);
    let token = env.register_stellar_asset_contract_v2(admin.clone());
    (token.address(), admin)
}

#[test]
fn test_create_stream_persists_state() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_address, _admin) = create_token_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let stellar_asset = token::StellarAssetClient::new(&env, &token_address);
    stellar_asset.mint(&sender, &1_000);

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let stream_id = client.create_stream(&sender, &recipient, &token_address, &500, &100);
    assert_eq!(stream_id, 1);

    let stream = client.get_stream(&stream_id).unwrap();
    assert_eq!(stream.sender, sender);
    assert_eq!(stream.recipient, recipient);
    assert_eq!(stream.token_address, token_address);
    assert_eq!(stream.rate_per_second, 5);
    assert_eq!(stream.deposited_amount, 500);
    assert_eq!(stream.withdrawn_amount, 0);
    assert!(stream.is_active);
}

#[test]
fn test_create_multiple_streams_increments_counter() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_address, _admin) = create_token_contract(&env);
    let sender = Address::generate(&env);
    let recipient1 = Address::generate(&env);
    let recipient2 = Address::generate(&env);

    let stellar_asset = token::StellarAssetClient::new(&env, &token_address);
    stellar_asset.mint(&sender, &2_000);

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let stream_id1 = client.create_stream(&sender, &recipient1, &token_address, &500, &100);
    let stream_id2 = client.create_stream(&sender, &recipient2, &token_address, &500, &100);

    assert_eq!(stream_id1, 1);
    assert_eq!(stream_id2, 2);
}

#[test]
fn test_withdraw_rejects_non_recipient() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_address, _admin) = create_token_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let attacker = Address::generate(&env);

    let stellar_asset = token::StellarAssetClient::new(&env, &token_address);
    stellar_asset.mint(&sender, &1_000);

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let stream_id = client.create_stream(&sender, &recipient, &token_address, &500, &100);

    let unauthorized_result = client.try_withdraw(&attacker, &stream_id);
    assert_eq!(unauthorized_result, Err(Ok(StreamError::Unauthorized)));

    let stream = client.get_stream(&stream_id).unwrap();
    assert_eq!(stream.withdrawn_amount, 0);
    assert!(stream.is_active);
}

#[test]
fn test_withdraw_authorized_recipient_receives_tokens() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_address, _admin) = create_token_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let stellar_asset = token::StellarAssetClient::new(&env, &token_address);
    stellar_asset.mint(&sender, &1_000);

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);
    let token_client = token::Client::new(&env, &token_address);

    let stream_id = client.create_stream(&sender, &recipient, &token_address, &500, &100);
    let recipient_balance_before = token_client.balance(&recipient);

    let _ = client.withdraw(&recipient, &stream_id);

    let recipient_balance_after = token_client.balance(&recipient);
    assert_eq!(recipient_balance_after - recipient_balance_before, 500);

    let stream = client.get_stream(&stream_id).unwrap();
    assert_eq!(stream.withdrawn_amount, 500);
    assert!(!stream.is_active);
}

#[test]
fn test_top_up_stream_success() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_address, _admin) = create_token_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let stellar_asset = token::StellarAssetClient::new(&env, &token_address);
    stellar_asset.mint(&sender, &20_000);

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let stream_id = client.create_stream(&sender, &recipient, &token_address, &10_000, &100);

    let top_up_result = client.try_top_up_stream(&sender, &stream_id, &5_000);
    assert!(top_up_result.is_ok());

    let stream = client.get_stream(&stream_id).unwrap();
    assert_eq!(stream.deposited_amount, 15_000);
}

#[test]
fn test_top_up_stream_invalid_amount() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_address, _admin) = create_token_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let stellar_asset = token::StellarAssetClient::new(&env, &token_address);
    stellar_asset.mint(&sender, &20_000);

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let stream_id = client.create_stream(&sender, &recipient, &token_address, &10_000, &100);

    let negative_result = client.try_top_up_stream(&sender, &stream_id, &-100);
    assert_eq!(negative_result, Err(Ok(StreamError::InvalidAmount)));

    let zero_result = client.try_top_up_stream(&sender, &stream_id, &0);
    assert_eq!(zero_result, Err(Ok(StreamError::InvalidAmount)));
}

#[test]
fn test_top_up_stream_not_found() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let sender = Address::generate(&env);
    let stream_id = 999_u64;

    let result = client.try_top_up_stream(&sender, &stream_id, &1_000);
    assert_eq!(result, Err(Ok(StreamError::StreamNotFound)));
}

#[test]
fn test_top_up_stream_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_address, _admin) = create_token_contract(&env);
    let sender = Address::generate(&env);
    let attacker = Address::generate(&env);
    let recipient = Address::generate(&env);

    let stellar_asset = token::StellarAssetClient::new(&env, &token_address);
    stellar_asset.mint(&sender, &20_000);

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let stream_id = client.create_stream(&sender, &recipient, &token_address, &10_000, &100);

    let result = client.try_top_up_stream(&attacker, &stream_id, &1_000);
    assert_eq!(result, Err(Ok(StreamError::Unauthorized)));
}

#[test]
fn test_top_up_stream_inactive() {
    let env = Env::default();
    env.mock_all_auths();

    let (token_address, _admin) = create_token_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    let stellar_asset = token::StellarAssetClient::new(&env, &token_address);
    stellar_asset.mint(&sender, &20_000);

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let stream_id = client.create_stream(&sender, &recipient, &token_address, &10_000, &100);
    let _ = client.cancel_stream(&sender, &stream_id);

    let result = client.try_top_up_stream(&sender, &stream_id, &1_000);
    assert_eq!(result, Err(Ok(StreamError::StreamInactive)));
}

#[test]
fn datakey_stream_serializes_deterministically_and_works_in_storage() {
    let env = Env::default();
    let contract_id = env.register(StreamContract, ());
    let key = DataKey::Stream(42_u64);

    let key_scval_a: xdr::ScVal = (&key).try_into().unwrap();
    let key_scval_b: xdr::ScVal = (&key).try_into().unwrap();
    assert_eq!(key_scval_a, key_scval_b);

    let expected_key_scval: xdr::ScVal =
        (&(Symbol::new(&env, "Stream"), 42_u64)).try_into().unwrap();
    assert_eq!(key_scval_a, expected_key_scval);

    let decoded_key = DataKey::try_from_val(&env, &key_scval_a).unwrap();
    assert_eq!(decoded_key, key);

    let stream = Stream {
        sender: Address::generate(&env),
        recipient: Address::generate(&env),
        token_address: Address::generate(&env),
        rate_per_second: 100,
        deposited_amount: 1_000,
        withdrawn_amount: 0,
        start_time: 1,
        last_update_time: 1,
        is_active: true,
    };

    env.as_contract(&contract_id, || {
        env.storage().persistent().set(&key, &stream);
        let stored: Stream = env.storage().persistent().get(&key).unwrap();
        assert_eq!(stored, stream);
    });
}
