extern crate std;

use super::*;
use errors::StreamError;
use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, token, vec, Address, Env, Vec};

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

fn advance(env: &Env, seconds: u64) {
    env.ledger().with_mut(|l| l.timestamp += seconds);
}

fn batch_input(
    recipient: &Address,
    token_address: &Address,
    amount: i128,
    duration: u64,
) -> BatchStreamInput {
    BatchStreamInput {
        recipient: recipient.clone(),
        token_address: token_address.clone(),
        amount,
        duration,
        cliff_duration: None,
    }
}

// ─── Stream lookup / TTL ────────────────────────────────────────────────────

#[test]
fn withdraw_requires_existing_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let client = contract(&env);

    assert_eq!(
        client.try_withdraw(&Address::generate(&env), &999),
        Err(Ok(StreamError::StreamNotFound))
    );
}

#[test]
fn extend_stream_ttl_requires_existing_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let client = contract(&env);

    assert_eq!(
        client.try_extend_stream_ttl(&999),
        Err(Ok(StreamError::StreamNotFound))
    );
}

#[test]
fn extend_stream_ttl_renews_an_existing_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let client = contract(&env);
    let t = token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &t, &sender, 1_000);
    let id = client.create_stream(&sender, &recipient, &t, &1_000, &100);

    // Permissionless: no auth is required to renew a live record.
    env.set_auths(&[]);
    client.extend_stream_ttl(&id);

    assert!(client.get_stream(&id).is_some());
    assert_eq!(client.get_claimable_amount(&id), Some(0));
}

// ─── Recipient transfer ─────────────────────────────────────────────────────

#[test]
fn transfer_recipient_moves_claim_rights() {
    let env = Env::default();
    env.mock_all_auths();
    let client = contract(&env);
    let t = token(&env);
    let sender = Address::generate(&env);
    let first = Address::generate(&env);
    let second = Address::generate(&env);
    mint(&env, &t, &sender, 1_000);
    let id = client.create_stream(&sender, &first, &t, &1_000, &100);

    advance(&env, 40);
    client.transfer_recipient(&first, &id, &second);

    // The accrued interval is settled to the outgoing recipient...
    assert_eq!(token::Client::new(&env, &t).balance(&first), 400);
    assert_eq!(client.get_claimable_amount(&id), Some(0));

    // ...and the previous recipient can no longer withdraw.
    assert_eq!(
        client.try_withdraw(&first, &id),
        Err(Ok(StreamError::Unauthorized))
    );

    // The new recipient accrues from the transfer onwards.
    advance(&env, 40);
    assert_eq!(client.withdraw(&second, &id), 400);
}

#[test]
fn transfer_recipient_requires_the_current_recipient() {
    let env = Env::default();
    env.mock_all_auths();
    let client = contract(&env);
    let t = token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &t, &sender, 1_000);
    let id = client.create_stream(&sender, &recipient, &t, &1_000, &100);

    let outsider = Address::generate(&env);
    assert_eq!(
        client.try_transfer_recipient(&outsider, &id, &Address::generate(&env)),
        Err(Ok(StreamError::Unauthorized))
    );

    // Even the sender cannot reassign the recipient unilaterally.
    assert_eq!(
        client.try_transfer_recipient(&sender, &id, &Address::generate(&env)),
        Err(Ok(StreamError::Unauthorized))
    );
}

// ─── Batch creation ─────────────────────────────────────────────────────────

#[test]
fn batch_create_streams_deposits_every_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let client = contract(&env);
    let t = token(&env);
    let sender = Address::generate(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    mint(&env, &t, &sender, 1_000);

    let inputs = vec![
        &env,
        batch_input(&alice, &t, 300, 100),
        batch_input(&bob, &t, 200, 200),
    ];
    let ids = client.batch_create_streams(&sender, &inputs);

    assert_eq!(ids.len(), 2);
    assert_ne!(ids.get(0).unwrap(), ids.get(1).unwrap());
    assert_eq!(token::Client::new(&env, &t).balance(&client.address), 500);

    let first = ids.get(0).unwrap();
    advance(&env, 100);
    assert_eq!(client.withdraw(&alice, &first), 300);
}

#[test]
fn batch_create_streams_rejects_an_empty_batch() {
    let env = Env::default();
    env.mock_all_auths();
    let client = contract(&env);
    let sender = Address::generate(&env);

    let empty: Vec<BatchStreamInput> = Vec::new(&env);
    assert_eq!(
        client.try_batch_create_streams(&sender, &empty),
        Err(Ok(StreamError::InvalidAmount))
    );
}

#[test]
fn batch_create_streams_requires_the_sender_authorisation() {
    let env = Env::default();
    env.mock_all_auths();
    let client = contract(&env);
    let t = token(&env);
    let sender = Address::generate(&env);
    mint(&env, &t, &sender, 1_000);
    let inputs = vec![&env, batch_input(&Address::generate(&env), &t, 100, 100)];

    env.set_auths(&[]);
    assert!(client.try_batch_create_streams(&sender, &inputs).is_err());
}

// ─── Protocol fees ──────────────────────────────────────────────────────────

fn init_with_fee(env: &Env, client: &StreamContractClient<'_>, fee_bps: u32) -> (Address, Address) {
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    client.initialize(&admin, &treasury, &fee_bps);
    (admin, treasury)
}

#[test]
fn configure_protocol_fees_is_admin_only() {
    let env = Env::default();
    env.mock_all_auths();
    let client = contract(&env);
    let (_, treasury) = init_with_fee(&env, &client, 0);
    let mut splits = Vec::new(&env);
    splits.push_back(FeeRecipient {
        recipient: treasury,
        share_bps: 10_000,
    });

    assert_eq!(
        client.try_configure_protocol_fees(&Address::generate(&env), &100, &splits, &true),
        Err(Ok(StreamError::NotAdmin))
    );

    // With no authorisation at all the host rejects the call before the body.
    env.set_auths(&[]);
    let admin = Address::generate(&env);
    assert!(client
        .try_configure_protocol_fees(&admin, &100, &splits, &true)
        .is_err());
}

#[test]
fn configure_protocol_fees_rejects_splits_that_do_not_sum_to_ten_thousand() {
    let env = Env::default();
    env.mock_all_auths();
    let client = contract(&env);
    let (admin, treasury) = init_with_fee(&env, &client, 0);
    let mut splits = Vec::new(&env);
    splits.push_back(FeeRecipient {
        recipient: treasury,
        share_bps: 4_000,
    });

    assert_eq!(
        client.try_configure_protocol_fees(&admin, &100, &splits, &true),
        Err(Ok(StreamError::InvalidFeeSplit))
    );
}

#[test]
fn protocol_fee_is_taken_from_the_deposit_on_creation() {
    let env = Env::default();
    env.mock_all_auths();
    let client = contract(&env);
    let t = token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (_admin, treasury) = init_with_fee(&env, &client, 500); // 5%
    mint(&env, &t, &sender, 1_000);

    let id = client.create_stream(&sender, &recipient, &t, &1_000, &100);

    assert_eq!(token::Client::new(&env, &t).balance(&treasury), 50);
    assert_eq!(token::Client::new(&env, &t).balance(&client.address), 950);
    assert_eq!(client.get_stream(&id).unwrap().deposited_amount, 950);
}

// ─── Hybrid cliff with fees enabled ─────────────────────────────────────────

#[test]
fn hybrid_cliff_with_protocol_fee_escrows_exactly_the_net_deposit() {
    let env = Env::default();
    env.mock_all_auths();
    let client = contract(&env);
    let t = token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let (_admin, treasury) = init_with_fee(&env, &client, 500); // 5%
    mint(&env, &t, &sender, 1_000);

    let id = client.create_hybrid_cliff_stream(&sender, &recipient, &t, &1_000, &500, &150, &80);

    // The fee is taken from the deposit before the schedule is built.
    assert_eq!(token::Client::new(&env, &t).balance(&treasury), 50);
    let stream = client.get_stream(&id).unwrap();
    assert_eq!(stream.deposited_amount, 950);
    assert!(stream.rate_per_second > 0);

    // However the tail is split, nothing beyond the net deposit is ever owed.
    advance(&env, 10_000);
    assert_eq!(client.get_claimable_amount(&id), Some(950));
    assert_eq!(client.withdraw(&recipient, &id), 950);
    assert!(client.is_stream_completed(&id));
}

// ─── Owner-indexed position lookups ─────────────────────────────────────────

#[test]
fn get_positions_by_owner_reports_the_documented_limitation() {
    let env = Env::default();
    env.mock_all_auths();
    let client = contract(&env);
    let t = token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &t, &sender, 1_000);
    client.create_stream(&sender, &recipient, &t, &1_000, &100);

    // `try_load_positions_by_owner` cannot enumerate contract storage, so the
    // owner index is served by the off-chain indexer; the on-chain getter says
    // so explicitly rather than pretending the owner has no positions.
    assert_eq!(
        client.try_get_positions_by_owner(&sender),
        Err(Ok(StreamError::StreamNotFound))
    );
}
