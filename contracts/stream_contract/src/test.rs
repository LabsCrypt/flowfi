#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token, xdr, Address, Env, Symbol, TryFromVal,
};

use errors::StreamError;
use events::{
    FeeCollectedEvent, StreamCancelledEvent, StreamCreatedEvent, StreamToppedUpEvent,
    TokensWithdrawnEvent,
};
use types::{DataKey, Stream};

// ─── Test Helpers ─────────────────────────────────────────────────────────────

/// Registers a Stellar asset contract and returns (token_address, token_admin).
fn create_token(env: &Env) -> (Address, Address) {
    let admin = Address::generate(env);
    let token = env.register_stellar_asset_contract_v2(admin.clone());
    (token.address(), admin)
}

/// Registers StreamContract and returns its client.
fn create_contract(env: &Env) -> StreamContractClient<'_> {
    let id = env.register(StreamContract, ());
    StreamContractClient::new(env, &id)
}

/// Mints `amount` of `token` to `recipient`.
fn mint(env: &Env, token_address: &Address, recipient: &Address, amount: i128) {
    let asset = token::StellarAssetClient::new(env, token_address);
    asset.mint(recipient, &amount);
}

// ─── DataKey Serialization ────────────────────────────────────────────────────

#[test]
fn test_datakey_stream_serializes_deterministically() {
    let env = Env::default();
    let contract_id = env.register(StreamContract, ());
    let key = DataKey::Stream(42_u64);

    // Same key must produce the same ScVal every time.
    let scval_a: xdr::ScVal = (&key).try_into().unwrap();
    let scval_b: xdr::ScVal = (&key).try_into().unwrap();
    assert_eq!(scval_a, scval_b);

    // Must match the canonical (Symbol, u64) tuple representation.
    let expected: xdr::ScVal = (&(Symbol::new(&env, "Stream"), 42_u64)).try_into().unwrap();
    assert_eq!(scval_a, expected);

    // Round-trip decode.
    let round_trip = DataKey::try_from_val(&env, &scval_a).unwrap();
    assert_eq!(round_trip, key);

    // Confirm persistent storage round-trip inside the contract context.
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

#[test]
fn test_datakey_stream_counter_serializes_deterministically() {
    let key = DataKey::StreamCounter;
    let scval_a: xdr::ScVal = (&key).try_into().unwrap();
    let scval_b: xdr::ScVal = (&key).try_into().unwrap();
    assert_eq!(scval_a, scval_b);
}

// ─── Protocol Initialization ──────────────────────────────────────────────────

#[test]
fn test_initialize_stores_config() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &250);

    let cfg = client.get_fee_config().unwrap();
    assert_eq!(cfg.admin, admin);
    assert_eq!(cfg.treasury, treasury);
    assert_eq!(cfg.fee_rate_bps, 250);
}

#[test]
fn test_initialize_rejects_second_call() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &100);
    let result = client.try_initialize(&admin, &treasury, &100);
    assert_eq!(result, Err(Ok(StreamError::AlreadyInitialized)));
}

#[test]
fn test_initialize_rejects_invalid_fee_rate() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    // 1 001 bps > MAX_FEE_RATE_BPS (1 000)
    let result = client.try_initialize(&admin, &treasury, &1001);
    assert_eq!(result, Err(Ok(StreamError::InvalidFeeRate)));
}

#[test]
fn test_update_fee_config_by_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let new_treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &500);
    client.update_fee_config(&admin, &new_treasury, &300);

    let cfg = client.get_fee_config().unwrap();
    assert_eq!(cfg.treasury, new_treasury);
    assert_eq!(cfg.fee_rate_bps, 300);
}

#[test]
fn test_update_fee_config_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &500);
    let result = client.try_update_fee_config(&attacker, &treasury, &100);
    assert_eq!(result, Err(Ok(StreamError::NotAdmin)));
}

#[test]
fn test_update_fee_config_rejects_invalid_fee_rate() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &500);
    let result = client.try_update_fee_config(&admin, &treasury, &1001);
    assert_eq!(result, Err(Ok(StreamError::InvalidFeeRate)));
}

// ─── create_stream ────────────────────────────────────────────────────────────

#[test]
fn test_create_stream_persists_state() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let stream_id = client.create_stream(&sender, &recipient, &token, &500, &100);
    assert_eq!(stream_id, 1);

    let s = client.get_stream(&stream_id).unwrap();
    assert_eq!(s.sender, sender);
    assert_eq!(s.recipient, recipient);
    assert_eq!(s.token_address, token);
    assert_eq!(s.rate_per_second, 5); // 500 / 100
    assert_eq!(s.deposited_amount, 500);
    assert_eq!(s.withdrawn_amount, 0);
    assert!(s.is_active);
}

#[test]
fn test_create_multiple_streams_increments_id() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);

    let client = create_contract(&env);
    let id1 = client.create_stream(&sender, &Address::generate(&env), &token, &500, &100);
    let id2 = client.create_stream(&sender, &Address::generate(&env), &token, &500, &100);
    assert_eq!(id1, 1);
    assert_eq!(id2, 2);
}

#[test]
fn test_create_stream_rejects_zero_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);

    let result = client.try_create_stream(
        &Address::generate(&env),
        &Address::generate(&env),
        &token,
        &0,
        &100,
    );
    assert_eq!(result, Err(Ok(StreamError::InvalidAmount)));
}

#[test]
fn test_create_stream_rejects_negative_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);

    let result = client.try_create_stream(
        &Address::generate(&env),
        &Address::generate(&env),
        &token,
        &-1,
        &100,
    );
    assert_eq!(result, Err(Ok(StreamError::InvalidAmount)));
}

#[test]
fn test_create_stream_rejects_zero_duration() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let client = create_contract(&env);

    let result = client.try_create_stream(&sender, &Address::generate(&env), &token, &500, &0);
    assert_eq!(result, Err(Ok(StreamError::InvalidDuration)));
}

#[test]
fn test_create_stream_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let stream_id = client.create_stream(&sender, &recipient, &token, &500, &100);

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "stream_created")
        })
        .expect("stream_created event not found");

    let payload: StreamCreatedEvent = StreamCreatedEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.stream_id, stream_id);
    assert_eq!(payload.sender, sender);
    assert_eq!(payload.recipient, recipient);
    assert_eq!(payload.deposited_amount, 500);
    assert_eq!(payload.rate_per_second, 5);
}

// ─── top_up_stream ────────────────────────────────────────────────────────────

#[test]
fn test_top_up_increases_deposited_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 20_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &10_000, &100);
    client.top_up_stream(&sender, &id, &5_000);

    let s = client.get_stream(&id).unwrap();
    assert_eq!(s.deposited_amount, 15_000);
}

#[test]
fn test_top_up_rejects_zero_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 20_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &10_000, &100);

    assert_eq!(
        client.try_top_up_stream(&sender, &id, &0),
        Err(Ok(StreamError::InvalidAmount))
    );
}

#[test]
fn test_top_up_rejects_negative_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 20_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &10_000, &100);

    assert_eq!(
        client.try_top_up_stream(&sender, &id, &-50),
        Err(Ok(StreamError::InvalidAmount))
    );
}

#[test]
fn test_top_up_rejects_nonexistent_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    assert_eq!(
        client.try_top_up_stream(&Address::generate(&env), &999, &1_000),
        Err(Ok(StreamError::StreamNotFound))
    );
}

#[test]
fn test_top_up_rejects_unauthorized_sender() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let attacker = Address::generate(&env);
    mint(&env, &token, &sender, 20_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &10_000, &100);

    assert_eq!(
        client.try_top_up_stream(&attacker, &id, &1_000),
        Err(Ok(StreamError::Unauthorized))
    );
}

#[test]
fn test_top_up_rejects_inactive_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 20_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &10_000, &100);
    client.cancel_stream(&sender, &id);

    assert_eq!(
        client.try_top_up_stream(&sender, &id, &1_000),
        Err(Ok(StreamError::StreamInactive))
    );
}

#[test]
fn test_top_up_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 20_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &10_000, &100);
    client.top_up_stream(&sender, &id, &5_000);

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "stream_topped_up")
        })
        .expect("stream_topped_up event not found");

    let payload: StreamToppedUpEvent = StreamToppedUpEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.stream_id, id);
    assert_eq!(payload.amount, 5_000);
    assert_eq!(payload.new_deposited_amount, 15_000);
}

// ─── withdraw ────────────────────────────────────────────────────────────────

#[test]
fn test_withdraw_transfers_tokens_to_recipient() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let token_client = token::Client::new(&env, &token);
    let id = client.create_stream(&sender, &recipient, &token, &500, &100);

    // Advance time by 100 seconds to allow full withdrawal (500 tokens / 100 seconds = 5 tokens/sec)
    env.ledger().with_mut(|l| {
        l.timestamp += 100;
    });

    let before = token_client.balance(&recipient);
    let claimed = client.withdraw(&recipient, &id);
    let after = token_client.balance(&recipient);

    assert_eq!(claimed, 500);
    assert_eq!(after - before, 500);

    let s = client.get_stream(&id).unwrap();
    assert_eq!(s.withdrawn_amount, 500);
    assert!(!s.is_active); // fully drained
}

#[test]
fn test_withdraw_rejects_non_recipient() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let attacker = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &500, &100);

    assert_eq!(
        client.try_withdraw(&attacker, &id),
        Err(Ok(StreamError::Unauthorized))
    );
}

#[test]
fn test_withdraw_rejects_missing_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    assert_eq!(
        client.try_withdraw(&Address::generate(&env), &999),
        Err(Ok(StreamError::StreamNotFound))
    );
}

#[test]
fn test_withdraw_rejects_inactive_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &500, &100);
    client.cancel_stream(&sender, &id);

    assert_eq!(
        client.try_withdraw(&recipient, &id),
        Err(Ok(StreamError::StreamInactive))
    );
}

#[test]
fn test_withdraw_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &500, &100);

    // Advance time by 100 seconds to allow full withdrawal (500 tokens / 100 seconds = 5 tokens/sec)
    env.ledger().with_mut(|l| {
        l.timestamp += 100;
    });

    client.withdraw(&recipient, &id);

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "tokens_withdrawn")
        })
        .expect("tokens_withdrawn event not found");

    let payload: TokensWithdrawnEvent = TokensWithdrawnEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.stream_id, id);
    assert_eq!(payload.recipient, recipient);
    assert_eq!(payload.amount, 500);
}

// ─── cancel_stream ────────────────────────────────────────────────────────────

#[test]
fn test_cancel_stream_refunds_unspent_balance() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let token_client = token::Client::new(&env, &token);

    let id = client.create_stream(&sender, &Address::generate(&env), &token, &500, &100);
    let sender_balance_before = token_client.balance(&sender);

    client.cancel_stream(&sender, &id);

    // Full 500 should be refunded since nothing was withdrawn.
    assert_eq!(token_client.balance(&sender) - sender_balance_before, 500);

    let s = client.get_stream(&id).unwrap();
    assert!(!s.is_active);
}

#[test]
fn test_cancel_stream_rejects_non_sender() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let attacker = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &500, &100);

    assert_eq!(
        client.try_cancel_stream(&attacker, &id),
        Err(Ok(StreamError::Unauthorized))
    );
}

#[test]
fn test_cancel_stream_rejects_missing_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    assert_eq!(
        client.try_cancel_stream(&Address::generate(&env), &999),
        Err(Ok(StreamError::StreamNotFound))
    );
}

#[test]
fn test_cancel_stream_rejects_already_inactive() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &500, &100);
    client.cancel_stream(&sender, &id);

    assert_eq!(
        client.try_cancel_stream(&sender, &id),
        Err(Ok(StreamError::StreamInactive))
    );
}

#[test]
fn test_cancel_stream_emits_event_with_refund_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &500, &100);
    client.cancel_stream(&sender, &id);

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "stream_cancelled")
        })
        .expect("stream_cancelled event not found");

    let payload: StreamCancelledEvent = StreamCancelledEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.stream_id, id);
    assert_eq!(payload.sender, sender);
    assert_eq!(payload.recipient, recipient);
    assert_eq!(payload.amount_withdrawn, 0);
    assert_eq!(payload.refunded_amount, 500);
}

// ─── Protocol Fee Integration ─────────────────────────────────────────────────

#[test]
fn test_create_stream_with_fee_deduction() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let treasury = Address::generate(&env);
    let admin = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let token_client = token::Client::new(&env, &token);

    // 2% fee (200 bps). Gross: 500, fee: 10, net: 490.
    client.initialize(&admin, &treasury, &200);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &500, &100);

    assert_eq!(token_client.balance(&treasury), 10);
    let s = client.get_stream(&id).unwrap();
    assert_eq!(s.deposited_amount, 490);
    assert_eq!(s.rate_per_second, 4); // 490 / 100 = 4 (integer division)
}

#[test]
fn test_top_up_with_fee_deduction() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let treasury = Address::generate(&env);
    let admin = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);

    let client = create_contract(&env);
    let token_client = token::Client::new(&env, &token);

    // 1% fee (100 bps). Create: gross 1 000, fee 10, net 990.
    client.initialize(&admin, &treasury, &100);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &1_000, &100);
    assert_eq!(token_client.balance(&treasury), 10);

    // Top up: gross 500, fee 5, net 495. Treasury total: 15.
    client.top_up_stream(&sender, &id, &500);
    assert_eq!(token_client.balance(&treasury), 15);

    let s = client.get_stream(&id).unwrap();
    assert_eq!(s.deposited_amount, 990 + 495);
}

#[test]
fn test_fee_collected_event_emitted_on_create() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let treasury = Address::generate(&env);
    let admin = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);

    // 5% fee (500 bps). Gross: 1 000, fee: 50.
    client.initialize(&admin, &treasury, &500);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &1_000, &100);

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "fee_collected")
        })
        .expect("fee_collected event not found");

    let payload: FeeCollectedEvent = FeeCollectedEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.stream_id, id);
    assert_eq!(payload.treasury, treasury);
    assert_eq!(payload.fee_amount, 50);
}

#[test]
fn test_no_fee_event_when_fee_rate_is_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);

    // 0 bps fee — no fee_collected event must be emitted.
    client.initialize(&admin, &treasury, &0);
    client.create_stream(&sender, &Address::generate(&env), &token, &1_000, &100);

    let events = env.events().all();
    let fee_event = events.iter().find(|e| {
        Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
            == Symbol::new(&env, "fee_collected")
    });
    assert!(
        fee_event.is_none(),
        "fee_collected must not fire when fee rate is 0"
    );
}

#[test]
fn test_no_fee_without_protocol_config() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    // No `initialize` call — fee collection is a silent no-op.
    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &500, &100);

    let s = client.get_stream(&id).unwrap();
    assert_eq!(s.deposited_amount, 500); // Full amount, no fee deducted.
}

#[test]
fn test_withdraw_time_based_calculation() {
    let env = Env::default();
    env.mock_all_auths();

    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let _token_client = token::Client::new(&env, &token);

    // Create stream: 1000 tokens over 1000 seconds = 1 token/second
    let stream_id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    // Advance time by 100 seconds
    env.ledger().with_mut(|l| {
        l.timestamp += 100;
    });

    // First withdrawal: should get 100 tokens (100 seconds * 1 token/second)
    let withdrawn1 = client.withdraw(&recipient, &stream_id);
    assert_eq!(withdrawn1, 100);

    let stream = client.get_stream(&stream_id).unwrap();
    assert_eq!(stream.withdrawn_amount, 100);
    assert_eq!(stream.last_update_time, env.ledger().timestamp());

    // Advance time by another 200 seconds
    env.ledger().with_mut(|l| {
        l.timestamp += 200;
    });

    // Second withdrawal: should get 200 tokens (200 seconds * 1 token/second)
    let withdrawn2 = client.withdraw(&recipient, &stream_id);
    assert_eq!(withdrawn2, 200);

    let stream = client.get_stream(&stream_id).unwrap();
    assert_eq!(stream.withdrawn_amount, 300);
}

#[test]
fn test_withdraw_caps_at_remaining_balance() {
    let env = Env::default();
    env.mock_all_auths();

    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let _token_client = token::Client::new(&env, &token);

    // Create stream: 100 tokens over 100 seconds = 1 token/second
    let stream_id = client.create_stream(&sender, &recipient, &token, &100, &100);

    // Advance time by 200 seconds (more than the stream duration)
    env.ledger().with_mut(|l| {
        l.timestamp += 200;
    });

    // Withdrawal should be capped at remaining balance (100 tokens), not 200
    let withdrawn = client.withdraw(&recipient, &stream_id);
    assert_eq!(withdrawn, 100);

    let stream = client.get_stream(&stream_id).unwrap();
    assert_eq!(stream.withdrawn_amount, 100);
    assert!(!stream.is_active);
}

#[test]
fn test_cancel_stream_refunds_sender() {
    let env = Env::default();
    env.mock_all_auths();

    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);
    let token_client = token::Client::new(&env, &token);

    // Create stream: 1000 tokens over 1000 seconds = 1 token/second
    let stream_id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    let sender_balance_before = token_client.balance(&sender);

    // Advance time by 300 seconds (300 tokens should be claimable by recipient)
    env.ledger().with_mut(|l| {
        l.timestamp += 300;
    });

    // Cancel stream: should pay 300 to recipient and refund 700 to sender
    client.cancel_stream(&sender, &stream_id);

    let sender_balance_after = token_client.balance(&sender);
    let contract_balance_after = token_client.balance(&contract_id);
    let recipient_balance_after = token_client.balance(&recipient);

    // Sender should receive 700 tokens back
    assert_eq!(sender_balance_after - sender_balance_before, 700);
    // Recipient should receive final claimable 300 immediately
    assert_eq!(recipient_balance_after, 300);
    // Contract should be fully drained
    assert_eq!(contract_balance_after, 0);

    let stream = client.get_stream(&stream_id).unwrap();
    assert!(!stream.is_active);
    assert_eq!(stream.withdrawn_amount, 300);
}

#[test]
fn test_cancel_stream_after_partial_withdrawal() {
    let env = Env::default();
    env.mock_all_auths();

    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let contract_id = env.register(StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);
    let token_client = token::Client::new(&env, &token);

    // Create stream: 1000 tokens over 1000 seconds = 1 token/second
    let stream_id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    // Advance time by 200 seconds
    env.ledger().with_mut(|l| {
        l.timestamp += 200;
    });

    // Recipient withdraws 200 tokens
    client.withdraw(&recipient, &stream_id);

    let sender_balance_before = token_client.balance(&sender);
    let _contract_balance_before = token_client.balance(&contract_id);

    // Advance time by another 100 seconds (100 more tokens accrued)
    env.ledger().with_mut(|l| {
        l.timestamp += 100;
    });

    // Cancel stream: should pay final 100 to recipient and refund 700 to sender
    client.cancel_stream(&sender, &stream_id);

    let sender_balance_after = token_client.balance(&sender);
    let contract_balance_after = token_client.balance(&contract_id);
    let recipient_balance_after = token_client.balance(&recipient);

    // Sender should receive 700 tokens back
    assert_eq!(sender_balance_after - sender_balance_before, 700);
    // Recipient should now hold total 300 (200 withdrawn earlier + 100 settled at cancel)
    assert_eq!(recipient_balance_after, 300);
    // Contract should be fully drained
    assert_eq!(contract_balance_after, 0);
}
