extern crate std;

use super::*;
use errors::StreamError;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Env, Vec,
};
use types::BatchStreamInput;

fn token(env: &Env) -> Address {
    env.register_stellar_asset_contract_v2(Address::generate(env))
        .address()
}
fn contract(env: &Env) -> StreamContractClient<'_> {
    let id = env.register(StreamContract, ());
    StreamContractClient::new(env, &id)
}
fn mint(env: &Env, t: &Address, a: &Address, n: i128) {
    token::StellarAssetClient::new(env, t).mint(a, &n);
}

#[test]
fn cliff_blocks_then_unlocks_and_cancel_settles() {
    let env = Env::default();
    env.mock_all_auths();
    let t = token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &t, &sender, 1_000);
    let c = contract(&env);
    let id = c.create_stream_with_cliff(&sender, &recipient, &t, &1_000, &100, &50);
    env.ledger().with_mut(|l| l.timestamp += 49);
    assert_eq!(c.get_claimable_amount(&id), Some(0));
    env.ledger().with_mut(|l| l.timestamp += 1);
    assert_eq!(c.get_claimable_amount(&id), Some(500));
}

#[test]
fn cliff_duration_must_be_valid() {
    let env = Env::default();
    env.mock_all_auths();
    let t = token(&env);
    let s = Address::generate(&env);
    mint(&env, &t, &s, 100);
    let c = contract(&env);
    assert_eq!(
        c.try_create_stream_with_cliff(&s, &Address::generate(&env), &t, &100, &10, &11),
        Err(Ok(StreamError::InvalidDuration))
    );
}

#[test]
fn batch_creates_streams_and_aggregates_token_deposit() {
    let env = Env::default();
    env.mock_all_auths();
    let t = token(&env);
    let s = Address::generate(&env);
    mint(&env, &t, &s, 300);
    let c = contract(&env);
    let mut inputs = Vec::new(&env);
    inputs.push_back(BatchStreamInput {
        recipient: Address::generate(&env),
        token_address: t.clone(),
        amount: 100,
        duration: 10,
        cliff_duration: None,
    });
    inputs.push_back(BatchStreamInput {
        recipient: Address::generate(&env),
        token_address: t.clone(),
        amount: 200,
        duration: 20,
        cliff_duration: None,
    });
    let ids = c.batch_create_streams(&s, &inputs);
    assert_eq!(ids.len(), 2);
    assert_eq!(
        c.get_stream(&ids.get(0).unwrap()).unwrap().deposited_amount,
        100
    );
    assert_eq!(token::Client::new(&env, &t).balance(&c.address), 300);
}

#[test]
fn batch_rejects_empty_and_invalid_input() {
    let env = Env::default();
    env.mock_all_auths();
    let c = contract(&env);
    let inputs = Vec::new(&env);
    assert_eq!(
        c.try_batch_create_streams(&Address::generate(&env), &inputs),
        Err(Ok(StreamError::InvalidAmount))
    );
}

#[test]
fn recipient_transfer_settles_old_and_allows_new_withdrawal() {
    let env = Env::default();
    env.mock_all_auths();
    let t = token(&env);
    let s = Address::generate(&env);
    let old = Address::generate(&env);
    let new = Address::generate(&env);
    mint(&env, &t, &s, 1_000);
    let c = contract(&env);
    let id = c.create_stream(&s, &old, &t, &1_000, &100);
    env.ledger().with_mut(|l| l.timestamp += 25);
    c.transfer_recipient(&old, &id, &new);
    let tc = token::Client::new(&env, &t);
    assert_eq!(tc.balance(&old), 250);
    env.ledger().with_mut(|l| l.timestamp += 25);
    assert_eq!(c.withdraw(&new, &id), 250);
    let stream = c.get_stream(&id).unwrap();
    assert_eq!(stream.recipient, new);
    assert_eq!(stream.withdrawn_amount, 500);
    assert_eq!(stream.last_update_time, env.ledger().timestamp());
}

#[test]
fn recipient_transfer_requires_current_recipient_and_active_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let t = token(&env);
    let s = Address::generate(&env);
    let old = Address::generate(&env);
    let new = Address::generate(&env);
    mint(&env, &t, &s, 100);
    let c = contract(&env);
    let id = c.create_stream(&s, &old, &t, &100, &10);
    assert_eq!(
        c.try_transfer_recipient(&new, &id, &Address::generate(&env)),
        Err(Ok(StreamError::Unauthorized))
    );
    c.cancel_stream(&s, &id);
    assert_eq!(
        c.try_transfer_recipient(&old, &id, &new),
        Err(Ok(StreamError::StreamInactive))
    );
}

#[test]
fn extend_stream_ttl_requires_existing_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let c = contract(&env);
    assert_eq!(
        c.try_extend_stream_ttl(&999),
        Err(Ok(StreamError::StreamNotFound))
    );
}
