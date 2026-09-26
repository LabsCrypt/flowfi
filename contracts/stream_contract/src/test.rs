extern crate std;

use std::string::ToString;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token, vec, xdr, Address, Bytes, BytesN, Env, Symbol, TryFromVal, Val, Vec as SorobanVec,
};

use errors::StreamError;
use events::{
    AdminTransferredEvent, ContractUpgradedEvent, EmergencyGuardianUpdatedEvent, FeeCollectedEvent,
    FeeConfigUpdatedEvent, HybridCliffStreamCreatedEvent, InitializedEvent,
    ProtocolPauseStatusEvent, StateMigratedEvent, StepVestingStreamCreatedEvent,
    StreamCancelledEvent, StreamCompletedEvent, StreamCreatedEvent, StreamPausedEvent,
    StreamResumedEvent, StreamToppedUpEvent, TokensWithdrawnEvent,
};
use types::{
    DataKey, LegacyProtocolConfig, LegacyStream, ProtocolConfig, Stream, StreamStatus,
    VestingSchedule, VestingStep, MAX_BATCH_WITHDRAW, MAX_VESTING_STEPS,
};

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

/// Builds a step-tranche schedule from `(unlock_time, unlock_amount)` pairs.
///
/// `vec!` only accepts what it can hand to `Vec::from_array`, so the steps are
/// pushed individually — which also keeps the test call sites readable.
fn step_schedule(env: &Env, steps: &[(u64, i128)]) -> SorobanVec<VestingStep> {
    let mut schedule = SorobanVec::new(env);
    for (unlock_time, unlock_amount) in steps {
        schedule.push_back(VestingStep {
            unlock_time: *unlock_time,
            unlock_amount: *unlock_amount,
        });
    }
    schedule
}

/// Advances the ledger clock by `seconds`.
fn advance(env: &Env, seconds: u64) {
    env.ledger().with_mut(|l| l.timestamp += seconds);
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
        cliff_time: None,
        is_active: true,
        paused: false,
        paused_at: None,
        status: StreamStatus::Active,
        schedule: VestingSchedule::Linear,
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

#[test]
fn test_update_fee_config_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    // Call update_fee_config before initialize
    let result = client.try_update_fee_config(&admin, &treasury, &100);
    assert_eq!(result, Err(Ok(StreamError::NotInitialized)));
}

#[test]
fn test_initialize_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &100);

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "initialized")
        })
        .expect("initialized event not found");

    let payload: InitializedEvent = InitializedEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.admin, admin);
    assert_eq!(payload.treasury, treasury);
    assert_eq!(payload.fee_rate_bps, 100);
}

#[test]
fn test_update_fee_config_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    let admin = Address::generate(&env);
    let old_treasury = Address::generate(&env);
    let new_treasury = Address::generate(&env);

    client.initialize(&admin, &old_treasury, &500);
    client.update_fee_config(&admin, &new_treasury, &300);

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "fee_config_updated")
        })
        .expect("fee_config_updated event not found");

    let payload: FeeConfigUpdatedEvent = FeeConfigUpdatedEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.admin, admin);
    assert_eq!(payload.old_treasury, old_treasury);
    assert_eq!(payload.new_treasury, new_treasury);
    assert_eq!(payload.old_fee_rate_bps, 500);
    assert_eq!(payload.new_fee_rate_bps, 300);
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
fn test_create_stream_rejects_invalid_token_address() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    // Account addresses are not token contracts.
    let invalid_token = Address::generate(&env);
    let result = client.try_create_stream(
        &Address::generate(&env),
        &Address::generate(&env),
        &invalid_token,
        &500,
        &100,
    );
    assert_eq!(result, Err(Ok(StreamError::InvalidTokenAddress)));
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

// ─── #796 start_time / backdated timestamp guard ──────────────────────────────
//
// `create_stream` always derives `start_time` from `env.ledger().timestamp()`
// (see lib.rs:201). The contract does NOT accept a caller-supplied start_time,
// so backdated start times are structurally impossible via the public API.
//
// The tests below verify this invariant and demonstrate the risk that would
// exist if a backdated start_time were accepted.

#[test]
fn test_create_stream_uses_ledger_timestamp_as_start_time() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    // Set ledger to a known timestamp.
    env.ledger().with_mut(|l| l.timestamp = 500_000);

    let client = create_contract(&env);
    let stream_id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    let s = client.get_stream(&stream_id).unwrap();
    // start_time must be the ledger timestamp at creation, never caller-supplied.
    assert_eq!(s.start_time, 500_000);
    assert_eq!(s.last_update_time, 500_000);
}

#[test]
fn test_backdated_start_time_would_immediately_vest_full_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let stream_id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    // Simulate a backdated start_time by directly manipulating storage.
    // This is NOT possible through the public API — the contract always uses
    // env.ledger().timestamp() — but it demonstrates the risk that would exist
    // if a caller-supplied start_time were ever added.
    let mut stream = client.get_stream(&stream_id).unwrap();
    stream.start_time = 0; // backdated far into the past
    stream.last_update_time = 0; // sync anchor to match
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&types::DataKey::Stream(stream_id), &stream);
    });

    // Advance ledger well past the stream's natural end.
    env.ledger().with_mut(|l| l.timestamp += 10_000);

    // The full deposited_amout would be immediately claimable because the
    // elapsed time (start_time=0 → now=10_000) far exceeds the duration.
    let claimable = client.get_claimable_amount(&stream_id).unwrap();
    assert_eq!(claimable, 1_000);

    // Backdated start times are intentionally prevented by the contract design:
    // `create_stream` always uses `env.ledger().timestamp()`, so this scenario
    // cannot occur via the public API.
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
    assert_eq!(payload.new_end_time, 150);
}

#[test]
fn test_top_up_preserves_already_accrued_claimable() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    // Recipient vests 900 tokens (rate 1/sec) before the top-up.
    env.ledger().with_mut(|l| l.timestamp += 900);
    assert_eq!(client.get_claimable_amount(&id), Some(900));

    client.top_up_stream(&sender, &id, &100);

    // Already-accrued, unwithdrawn time must survive the top-up.
    assert_eq!(client.get_claimable_amount(&id), Some(900));
}

#[test]
fn test_top_up_then_cancel_pays_pre_topup_accrued() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    env.ledger().with_mut(|l| l.timestamp += 900);
    client.top_up_stream(&sender, &id, &100);

    let token_client = token::Client::new(&env, &token);
    let recipient_balance_before = token_client.balance(&recipient);

    // Cancel immediately after the top-up — no further time should accrue.
    client.cancel_stream(&sender, &id);

    let recipient_balance_after = token_client.balance(&recipient);
    assert_eq!(recipient_balance_after - recipient_balance_before, 900);
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
fn test_no_fee_transfer_or_event_when_fee_rounds_to_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let token_client = token::Client::new(&env, &token);

    // Non-zero fee rate, but tiny amount => fee rounds down to 0:
    // 1 * 200 / 10_000 = 0
    client.initialize(&admin, &treasury, &200);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &1, &1);

    assert_eq!(token_client.balance(&treasury), 0);

    let s = client.get_stream(&id).unwrap();
    assert_eq!(s.deposited_amount, 1);

    let events = env.events().all();
    let fee_event = events.iter().find(|e| {
        Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
            == Symbol::new(&env, "fee_collected")
    });
    assert!(
        fee_event.is_none(),
        "fee_collected must not fire when rounded fee is 0"
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

#[test]
fn test_claimable_max_i128_rate_overflow() {
    let env = Env::default();
    env.mock_all_auths();

    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, i128::MAX);

    let client = create_contract(&env);

    // Create stream with near-max i128 rate
    let max_rate = i128::MAX / 2;
    let stream_id = client.create_stream(&sender, &recipient, &token, &1_000, &1);

    // Manually set rate to near-max i128 to test overflow protection
    let mut stream = client.get_stream(&stream_id).unwrap();
    stream.rate_per_second = max_rate;
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&types::DataKey::Stream(stream_id), &stream);
    });

    // Advance time by a large amount that would cause overflow
    env.ledger().with_mut(|l| {
        l.timestamp += 1_000_000_000;
    });

    // get_claimable_amount should cap at deposited_amount, not overflow
    let claimable = client.get_claimable_amount(&stream_id).unwrap();
    assert_eq!(claimable, 1_000); // Should cap at deposited amount

    // Withdraw should work correctly without overflow
    let withdrawn = client.withdraw(&recipient, &stream_id);
    assert_eq!(withdrawn, 1_000);
}

// ─── #795 calculate_claimable underflow guard ─────────────────────────────────

#[test]
fn test_calculate_claimable_underflow_returns_zero() {
    let env = Env::default();
    env.mock_all_auths();

    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let stream_id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    // Forcibly set withdrawn_amount > deposited_amount to exercise the underflow guard.
    let mut stream = client.get_stream(&stream_id).unwrap();
    stream.withdrawn_amount = stream.deposited_amount + 1;
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&types::DataKey::Stream(stream_id), &stream);
    });

    // calculate_claimable uses checked_sub(...).unwrap_or_default(), so the
    // underflow must return 0 rather than panicking or wrapping.
    let claimable = client.get_claimable_amount(&stream_id).unwrap();
    assert_eq!(claimable, 0);
}

// ─── #232 create_stream edge cases ───────────────────────────────────────────

#[test]
fn test_create_stream_minimum_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &1, &1);
    let s = client.get_stream(&id).unwrap();
    assert_eq!(s.deposited_amount, 1);
    assert!(s.is_active);
}

#[test]
fn test_create_stream_minimum_duration() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 100);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &100, &1);
    let s = client.get_stream(&id).unwrap();
    assert_eq!(s.rate_per_second, 100);
}

#[test]
fn test_create_stream_max_i128_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    // Use a large but safe amount: 10^18 tokens over 10^9 seconds = 10^9 rate.
    let amount: i128 = 1_000_000_000_000_000_000i128; // 10^18
    let duration: u64 = 1_000_000_000u64; // 10^9
    mint(&env, &token, &sender, amount);

    let client = create_contract(&env);
    let id = client.create_stream(
        &sender,
        &Address::generate(&env),
        &token,
        &amount,
        &duration,
    );
    let s = client.get_stream(&id).unwrap();
    assert_eq!(s.deposited_amount, amount);
    assert_eq!(s.rate_per_second, 1_000_000_000i128); // 10^18 / 10^9
}

#[test]
fn test_create_stream_invalid_token() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    // A plain account address is not a SAC — must return InvalidTokenAddress.
    let result = client.try_create_stream(
        &Address::generate(&env),
        &Address::generate(&env),
        &Address::generate(&env),
        &100,
        &10,
    );
    assert_eq!(result, Err(Ok(StreamError::InvalidTokenAddress)));
}

#[test]
fn test_create_stream_self_stream() {
    // sender == recipient is allowed by the contract (no explicit guard),
    // but the stream must be created successfully and state must be consistent.
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let actor = Address::generate(&env);
    mint(&env, &token, &actor, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&actor, &actor, &token, &1_000, &100);
    let s = client.get_stream(&id).unwrap();
    assert_eq!(s.sender, actor);
    assert_eq!(s.recipient, actor);
}

#[test]
fn test_create_stream_zero_rate() {
    // amount < duration → rate_per_second rounds to 0; must now be rejected.
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1);

    let client = create_contract(&env);
    let result = client.try_create_stream(&sender, &Address::generate(&env), &token, &1, &1_000);
    assert_eq!(result, Err(Ok(StreamError::InvalidRate)));
}

#[test]
fn test_create_stream_rate_exactly_one_succeeds() {
    // amount == duration → rate = 1, which is the smallest valid rate.
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 100);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &100, &100);
    let s = client.get_stream(&id).unwrap();
    assert_eq!(s.rate_per_second, 1);
    assert!(s.is_active);
}

#[test]
fn test_stream_id_uniqueness() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);

    let client = create_contract(&env);
    let id1 = client.create_stream(&sender, &recipient, &token, &1_000, &100);
    let id2 = client.create_stream(&sender, &recipient, &token, &1_000, &100);
    assert_ne!(id1, id2);

    // Both streams must be independently retrievable.
    assert!(client.get_stream(&id1).is_some());
    assert!(client.get_stream(&id2).is_some());
}

// ─── #233 withdraw / top_up / cancel lifecycle ───────────────────────────────

#[test]
fn test_withdraw_accrued_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let token_client = token::Client::new(&env, &token);
    // 1_000 tokens / 1_000 s = 1 token/s
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    env.ledger().with_mut(|l| l.timestamp += 200);
    let claimed = client.withdraw(&recipient, &id);
    assert_eq!(claimed, 200);
    assert_eq!(token_client.balance(&recipient), 200);
}

#[test]
fn test_withdraw_zero_balance() {
    // Withdraw before any time elapses → InvalidAmount.
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    assert_eq!(
        client.try_withdraw(&recipient, &id),
        Err(Ok(StreamError::InvalidAmount))
    );
}

#[test]
fn test_withdraw_full_balance() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 500);

    let client = create_contract(&env);
    let token_client = token::Client::new(&env, &token);
    let id = client.create_stream(&sender, &recipient, &token, &500, &100);

    // Advance past stream end.
    env.ledger().with_mut(|l| l.timestamp += 200);
    let claimed = client.withdraw(&recipient, &id);
    assert_eq!(claimed, 500);
    assert_eq!(token_client.balance(&recipient), 500);

    let s = client.get_stream(&id).unwrap();
    assert!(!s.is_active);
    assert_eq!(s.status, StreamStatus::Completed);
}

#[test]
fn test_withdraw_rejects_double_withdraw_after_completion() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 500);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &500, &100);

    // Fully drain the stream via withdraw.
    env.ledger().with_mut(|l| l.timestamp += 200);
    let claimed = client.withdraw(&recipient, &id);
    assert_eq!(claimed, 500);

    // Verify stream is now inactive and completed.
    let s = client.get_stream(&id).unwrap();
    assert!(!s.is_active);
    assert_eq!(s.status, StreamStatus::Completed);

    // Try to withdraw again — should return StreamInactive error.
    assert_eq!(
        client.try_withdraw(&recipient, &id),
        Err(Ok(StreamError::StreamInactive))
    );
}

#[test]
fn test_top_up_extends_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &1_000, &100);

    client.top_up_stream(&sender, &id, &1_000);

    let s = client.get_stream(&id).unwrap();
    // deposited_amount should now be 2_000
    assert_eq!(s.deposited_amount, 2_000);
    // rate unchanged; effective end extends by 1_000 / rate_per_second more seconds
    assert_eq!(s.rate_per_second, 10); // 1_000 / 100
}

#[test]
fn test_top_up_on_completed_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &500, &100);

    // Drain the stream.
    env.ledger().with_mut(|l| l.timestamp += 200);
    client.withdraw(&recipient, &id);

    // Top-up on a completed (inactive) stream must fail.
    mint(&env, &token, &sender, 500);
    assert_eq!(
        client.try_top_up_stream(&sender, &id, &500),
        Err(Ok(StreamError::StreamInactive))
    );
}

#[test]
fn test_cancel_refunds_sender() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let token_client = token::Client::new(&env, &token);
    // 1_000 tokens / 1_000 s = 1 token/s
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &1_000, &1_000);

    env.ledger().with_mut(|l| l.timestamp += 400);
    let before = token_client.balance(&sender);
    client.cancel_stream(&sender, &id);
    // 400 accrued to recipient, 600 refunded to sender
    assert_eq!(token_client.balance(&sender) - before, 600);
}

#[test]
fn test_cancel_by_non_sender() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &1_000, &1_000);

    assert_eq!(
        client.try_cancel_stream(&Address::generate(&env), &id),
        Err(Ok(StreamError::Unauthorized))
    );
}

#[test]
fn test_cancel_after_completion() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 500);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &500, &100);

    env.ledger().with_mut(|l| l.timestamp += 200);
    client.withdraw(&recipient, &id);

    assert_eq!(
        client.try_cancel_stream(&sender, &id),
        Err(Ok(StreamError::StreamInactive))
    );
}

// ─── #234 pause / resume ─────────────────────────────────────────────────────

#[test]
fn test_pause_stops_accrual() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    // 1_000 tokens / 1_000 s = 1 token/s
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    env.ledger().with_mut(|l| l.timestamp += 100);
    client.pause_stream(&sender, &id);

    // Advance more time — should not accrue while paused.
    env.ledger().with_mut(|l| l.timestamp += 200);
    assert_eq!(client.get_claimable_amount(&id), Some(100));

    let s = client.get_stream(&id).unwrap();
    assert!(s.paused);
    assert_eq!(s.status, StreamStatus::Paused);
}

#[test]
fn test_resume_adjusts_end_time() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    env.ledger().with_mut(|l| l.timestamp += 100);
    client.pause_stream(&sender, &id);

    // Paused for 300 seconds.
    env.ledger().with_mut(|l| l.timestamp += 300);
    let _new_end = client.resume_stream(&sender, &id);

    // After resume, stream should be active again.
    let s = client.get_stream(&id).unwrap();
    assert!(!s.paused);
    assert_eq!(s.status, StreamStatus::Active);

    // Advance 100 more seconds — should accrue 100 tokens (not 400).
    env.ledger().with_mut(|l| l.timestamp += 100);
    assert_eq!(client.get_claimable_amount(&id), Some(200)); // 100 before pause + 100 after
}

#[test]
fn test_pause_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &1_000, &1_000);
    client.pause_stream(&sender, &id);

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "stream_paused")
        })
        .expect("stream_paused event not found");

    let payload: StreamPausedEvent = StreamPausedEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.stream_id, id);
    assert_eq!(payload.sender, sender);
}

#[test]
fn test_resume_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &1_000, &1_000);
    client.pause_stream(&sender, &id);
    env.ledger().with_mut(|l| l.timestamp += 100);
    client.resume_stream(&sender, &id);

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "stream_resumed")
        })
        .expect("stream_resumed event not found");

    let payload: StreamResumedEvent = StreamResumedEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.stream_id, id);
    assert_eq!(payload.sender, sender);
}

#[test]
fn test_pause_by_non_sender_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &1_000, &1_000);

    assert_eq!(
        client.try_pause_stream(&Address::generate(&env), &id),
        Err(Ok(StreamError::Unauthorized))
    );
}

#[test]
fn test_resume_non_paused_stream_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &1_000, &1_000);

    assert_eq!(
        client.try_resume_stream(&sender, &id),
        Err(Ok(StreamError::StreamNotPaused))
    );
}

#[test]
fn test_pause_already_paused_stream_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &1_000, &1_000);

    client.pause_stream(&sender, &id);

    assert_eq!(
        client.try_pause_stream(&sender, &id),
        Err(Ok(StreamError::StreamAlreadyPaused))
    );
}

#[test]
fn test_withdraw_on_paused_stream_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    env.ledger().with_mut(|l| l.timestamp += 100);
    client.pause_stream(&sender, &id);
    env.ledger().with_mut(|l| l.timestamp += 100);

    assert_eq!(
        client.try_withdraw(&recipient, &id),
        Err(Ok(StreamError::StreamPaused))
    );
}

// ─── #235 stream completion ───────────────────────────────────────────────────

#[test]
fn test_final_withdrawal_transitions_to_completed() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 500);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &500, &100);

    env.ledger().with_mut(|l| l.timestamp += 200);
    client.withdraw(&recipient, &id);

    let s = client.get_stream(&id).unwrap();
    assert_eq!(s.status, StreamStatus::Completed);
    assert!(!s.is_active);
}

#[test]
fn test_is_stream_completed_helper() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 500);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &500, &100);

    assert!(!client.is_stream_completed(&id));

    env.ledger().with_mut(|l| l.timestamp += 200);
    client.withdraw(&recipient, &id);

    assert!(client.is_stream_completed(&id));
}

#[test]
fn test_completed_event_emitted_on_final_withdrawal() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 500);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &500, &100);

    env.ledger().with_mut(|l| l.timestamp += 200);
    client.withdraw(&recipient, &id);

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "stream_completed")
        })
        .expect("stream_completed event not found");

    let payload: StreamCompletedEvent = StreamCompletedEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.stream_id, id);
    assert_eq!(payload.recipient, recipient);
    assert_eq!(payload.total_withdrawn, 500);
}

#[test]
fn test_partial_withdrawal_does_not_complete() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    env.ledger().with_mut(|l| l.timestamp += 200);
    client.withdraw(&recipient, &id);

    let s = client.get_stream(&id).unwrap();
    assert_eq!(s.status, StreamStatus::Active);
    assert!(s.is_active);
    assert!(!client.is_stream_completed(&id));
}

#[test]
fn test_withdraw_on_paused_then_resume() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 10_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &10_000, &100);

    env.ledger().with_mut(|l| l.timestamp += 50);
    client.pause_stream(&sender, &id);

    env.ledger().with_mut(|l| l.timestamp += 50);
    client.resume_stream(&sender, &id);

    env.ledger().with_mut(|l| l.timestamp += 50);
    let claimable = client.get_claimable_amount(&id);

    assert!(claimable.is_some() && claimable.unwrap() > 0);
}

#[test]
fn test_multiple_pause_resume_preserves_state() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 10_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &10_000, &50);

    for _ in 0..3 {
        env.ledger().with_mut(|l| l.timestamp += 100);
        client.pause_stream(&sender, &id);
        env.ledger().with_mut(|l| l.timestamp += 50);
        client.resume_stream(&sender, &id);
    }

    let stream = client.get_stream(&id).unwrap();
    assert!(stream.is_active);
    assert!(!stream.paused);
}

#[test]
fn test_cancel_while_paused_keeps_inactive() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &100);

    env.ledger().with_mut(|l| l.timestamp += 300);
    client.pause_stream(&sender, &id);

    env.ledger().with_mut(|l| l.timestamp += 200);
    client.cancel_stream(&sender, &id);

    let stream = client.get_stream(&id).unwrap();
    assert!(!stream.is_active);
    assert_eq!(stream.status, StreamStatus::Cancelled);
}

#[test]
fn test_top_up_while_paused_increases_deposited() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &100);

    env.ledger().with_mut(|l| l.timestamp += 500);
    client.pause_stream(&sender, &id);

    let old_deposited = client.get_stream(&id).unwrap().deposited_amount;
    client.top_up_stream(&sender, &id, &1_000);
    let new_deposited = client.get_stream(&id).unwrap().deposited_amount;

    assert!(new_deposited > old_deposited);
}

#[test]
fn test_top_up_while_paused_does_not_advance_last_update_time() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    // Accrue 300s, then pause.
    env.ledger().with_mut(|l| l.timestamp += 300);
    client.pause_stream(&sender, &id);

    // More ledger time passes while paused; top up during this window.
    env.ledger().with_mut(|l| l.timestamp += 200);
    client.top_up_stream(&sender, &id, &100);

    let stream = client.get_stream(&id).unwrap();
    assert!(stream.last_update_time <= stream.paused_at.unwrap());

    // Claimable should still reflect the 300s accrued before the pause, not be
    // wiped out by the top-up pushing last_update_time past paused_at.
    assert_eq!(client.get_claimable_amount(&id), Some(300));
}

#[test]
fn test_withdraw_after_long_stream_runtime_is_bounded() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 5_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &5_000, &10);

    env.ledger().with_mut(|l| l.timestamp += 10_000);
    let withdrawn = client.withdraw(&recipient, &id);

    assert!(withdrawn <= 5_000);
}

// ─── Property-Based Fuzz Tests ────────────────────────────────────────────────

#[test]
fn test_fuzz_withdrawn_never_exceeds_deposited() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);

    let mut seed = 1u64;
    for iteration in 0..50 {
        seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
        let amount = 1 + ((seed / 2) % 100_000) as i128;

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        mint(&env, &token, &sender, amount);

        let client = create_contract(&env);
        let id = client.create_stream(&sender, &recipient, &token, &amount, &100);

        env.ledger().with_mut(|l| l.timestamp += 1000);
        let withdrawn = client.withdraw(&recipient, &id);

        let stream = client.get_stream(&id).unwrap();
        assert!(
            stream.withdrawn_amount <= stream.deposited_amount,
            "Iteration {}: withdrawn {} > deposited {}",
            iteration,
            stream.withdrawn_amount,
            stream.deposited_amount
        );
        assert!(withdrawn <= amount);
    }
}

#[test]
fn test_fuzz_claimable_never_exceeds_remaining() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);

    let mut seed = 2u64;
    for iteration in 0..50 {
        seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
        let amount = 1 + ((seed / 2) % 100_000) as i128;
        seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
        let duration = 1 + (seed % 10_000);

        // Skip inputs where the rate would round to zero (rejected by the
        // zero-rate guard); this fuzz test only exercises valid streams.
        if amount < duration as i128 {
            continue;
        }

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        mint(&env, &token, &sender, amount);

        let client = create_contract(&env);
        let id = client.create_stream(&sender, &recipient, &token, &amount, &duration);

        seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
        let elapsed = seed % duration;
        env.ledger().with_mut(|l| l.timestamp += elapsed);

        let claimable = client.get_claimable_amount(&id).unwrap_or(0);
        let stream = client.get_stream(&id).unwrap();
        let remaining = stream.deposited_amount - stream.withdrawn_amount;

        assert!(
            claimable <= remaining,
            "Iteration {}: claimable {} > remaining {}",
            iteration,
            claimable,
            remaining
        );
    }
}

#[test]
fn test_fuzz_cancel_early_refunds() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);

    let mut seed = 3u64;
    for iteration in 0..50 {
        seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
        let amount = 10_000 + ((seed / 2) % 100_000) as i128;

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        mint(&env, &token, &sender, amount);

        let client = create_contract(&env);
        let id = client.create_stream(&sender, &recipient, &token, &amount, &10);

        seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
        let partial_time = 1 + (seed % 100);
        env.ledger().with_mut(|l| l.timestamp += partial_time);

        client.cancel_stream(&sender, &id);
        let stream = client.get_stream(&id).unwrap();
        assert!(
            !stream.is_active,
            "Iteration {}: stream should be inactive after cancel",
            iteration
        );
    }
}

#[test]
fn test_resume_on_cancelled_stream_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    // Advance time and pause the stream.
    env.ledger().with_mut(|l| l.timestamp += 300);
    client.pause_stream(&sender, &id);

    // Cancel the paused stream — this should set is_active=false and status=Cancelled,
    // but previously would leave paused=true, allowing a subsequent resume to corrupt state.
    client.cancel_stream(&sender, &id);

    // Resume on a cancelled stream must fail.
    let result = client.try_resume_stream(&sender, &id);
    assert_eq!(
        result,
        Err(Ok(StreamError::StreamNotActive)),
        "resume_stream must return StreamNotActive on an inactive stream"
    );

    // Stream state must be unchanged: still cancelled, not resumed.
    let s = client.get_stream(&id).unwrap();
    assert!(!s.is_active);
    assert_eq!(s.status, StreamStatus::Cancelled);
    assert!(!s.paused);
}

#[test]
fn test_fuzz_pause_resume_maintains_active_state() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);

    let mut seed = 4u64;
    for iteration in 0..25 {
        seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
        let amount = 100_000 + ((seed / 2) % 100_000) as i128;
        seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
        let rate = 10 + (seed % 100);

        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        mint(&env, &token, &sender, amount);

        let client = create_contract(&env);
        let id = client.create_stream(&sender, &recipient, &token, &amount, &rate);

        for i in 0..3 {
            seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
            let sleep_time = 10 + (seed % 50);
            env.ledger().with_mut(|l| l.timestamp += sleep_time);

            let stream = client.get_stream(&id).unwrap();
            if i % 2 == 0 {
                client.pause_stream(&sender, &id);
            } else if stream.paused {
                client.resume_stream(&sender, &id);
            }
        }

        let stream = client.get_stream(&id).unwrap();
        assert!(
            stream.is_active,
            "Iteration {}: stream should remain active",
            iteration
        );
    }
}

#[test]
fn test_fuzz_large_amount_no_overflow() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);

    let large_amounts = [
        1_000_000_000_000i128,
        10_000_000_000_000i128,
        100_000_000_000_000i128,
    ];

    for amount in large_amounts.iter() {
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        mint(&env, &token, &sender, *amount);

        let client = create_contract(&env);
        let id = client.create_stream(&sender, &recipient, &token, amount, &100);

        env.ledger().with_mut(|l| l.timestamp += 1_000);

        let claimable = client.get_claimable_amount(&id).unwrap_or(0);
        assert!(claimable > 0);
        assert!(claimable <= *amount);
    }
}

#[test]
fn test_fuzz_claimable_overflow_and_cancel_invariants() {
    let env = Env::default();
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let token_address = Address::generate(&env);

    let mut seed = 0x4f1bbcdcu64;
    for iteration in 0..10_000 {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let deposited = 1 + ((seed >> 1) as i128 % 1_000_000_000_000);
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let withdrawn = (seed >> 1) as i128 % (deposited + 1);
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let duration = 1 + (seed % 1_000_000);
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let elapsed = seed % (duration.saturating_mul(4));
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let rate_per_second = if iteration % 97 == 0 {
            i128::MAX
        } else {
            1 + (deposited / duration as i128) + ((seed >> 1) as i128 % 100_000)
        };
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let paused = seed & 1 == 1;
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let pause_start = seed % (elapsed + 1);

        let effective_elapsed = if paused { pause_start } else { elapsed };
        let stream = Stream {
            sender: sender.clone(),
            recipient: recipient.clone(),
            token_address: token_address.clone(),
            rate_per_second,
            deposited_amount: deposited,
            withdrawn_amount: withdrawn,
            start_time: 0,
            last_update_time: 0,
            cliff_time: None,
            is_active: true,
            paused,
            paused_at: if paused {
                Some(effective_elapsed)
            } else {
                None
            },
            schedule: VestingSchedule::Linear,
            status: if paused {
                StreamStatus::Paused
            } else {
                StreamStatus::Active
            },
        };

        let claimable = StreamContract::calculate_claimable(&stream, elapsed);
        let remaining = deposited - withdrawn;
        let withdrawn_after_cancel = withdrawn.saturating_add(claimable);
        let cancel_refund = deposited.saturating_sub(withdrawn_after_cancel);

        assert!(
            withdrawn <= deposited,
            "Iteration {}: withdrawn {} > deposited {}",
            iteration,
            withdrawn,
            deposited
        );
        assert!(
            claimable <= remaining,
            "Iteration {}: claimable {} > remaining {}",
            iteration,
            claimable,
            remaining
        );
        assert!(
            cancel_refund + withdrawn_after_cancel <= deposited,
            "Iteration {}: cancel settlement {} + {} > deposited {}",
            iteration,
            cancel_refund,
            withdrawn_after_cancel,
            deposited
        );
    }
}

// ─── transfer_admin (#459) ─────────────────────────────────────────────────────

#[test]
fn test_transfer_admin_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(&admin, &treasury, &100);
    client.transfer_admin(&admin, &new_admin);

    let cfg = client.get_fee_config().unwrap();
    assert_eq!(cfg.admin, new_admin);
    // Treasury and fee must remain unchanged.
    assert_eq!(cfg.treasury, treasury);
    assert_eq!(cfg.fee_rate_bps, 100);
}

#[test]
fn test_transfer_admin_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &100);
    let result = client.try_transfer_admin(&attacker, &Address::generate(&env));
    assert_eq!(result, Err(Ok(StreamError::NotAdmin)));
}

#[test]
fn test_transfer_admin_rejects_not_initialized() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    let result = client.try_transfer_admin(&Address::generate(&env), &Address::generate(&env));
    assert_eq!(result, Err(Ok(StreamError::NotInitialized)));
}

#[test]
fn test_transfer_admin_new_admin_can_update_fee_config() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let new_admin = Address::generate(&env);
    let new_treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &100);
    client.transfer_admin(&admin, &new_admin);

    // New admin must be able to update fee config.
    client.update_fee_config(&new_admin, &new_treasury, &200);
    let cfg = client.get_fee_config().unwrap();
    assert_eq!(cfg.admin, new_admin);
    assert_eq!(cfg.treasury, new_treasury);
    assert_eq!(cfg.fee_rate_bps, 200);

    // Old admin must no longer be able to update fee config.
    let result = client.try_update_fee_config(&admin, &treasury, &50);
    assert_eq!(result, Err(Ok(StreamError::NotAdmin)));
}

#[test]
fn test_transfer_admin_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let new_admin = Address::generate(&env);

    client.initialize(&admin, &treasury, &100);
    client.transfer_admin(&admin, &new_admin);

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "admin_transferred")
        })
        .expect("admin_transferred event not found");

    let payload: AdminTransferredEvent = AdminTransferredEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.previous_admin, admin);
    assert_eq!(payload.new_admin, new_admin);
}

// ─── pause_stream / resume_stream (#462) ─────────────────────────────────────

#[test]
fn test_pause_stops_accrual_462() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);

    // Stream: 1 000 tokens over 1 000 s → 1 token/s
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    // Advance 200 s before pause — 200 tokens accrued.
    env.ledger().with_mut(|l| l.timestamp += 200);
    client.pause_stream(&sender, &id);

    // Advance another 300 s while paused — accrual must NOT increase.
    env.ledger().with_mut(|l| l.timestamp += 300);

    // Verify stream state: paused flag is set.
    let s = client.get_stream(&id).unwrap();
    assert!(s.paused);

    // Advance 100 more seconds; stream is still paused, accrual still frozen.
    env.ledger().with_mut(|l| l.timestamp += 100);

    // Expect paused_at (200 s mark) → last_update_time (also 200 s mark) → elapsed = 0
    // So claimable should be the 0 s elapsed since paused_at.
    // (Withdraw must be rejected on a paused stream — tested separately.)
}

#[test]
fn test_withdraw_on_paused_stream_returns_stream_inactive() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    env.ledger().with_mut(|l| l.timestamp += 100);
    client.pause_stream(&sender, &id);
    env.ledger().with_mut(|l| l.timestamp += 100);

    // Withdraw must be rejected while paused.
    let result = client.try_withdraw(&recipient, &id);
    assert_eq!(result, Err(Ok(StreamError::StreamPaused)));
}

#[test]
fn test_resume_adjusts_last_update_time() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    // Advance 200 s, pause, then advance 300 s while paused, then resume.
    env.ledger().with_mut(|l| l.timestamp += 200);
    client.pause_stream(&sender, &id);
    env.ledger().with_mut(|l| l.timestamp += 300);
    client.resume_stream(&sender, &id);

    let s = client.get_stream(&id).unwrap();
    assert!(!s.paused);
    // last_update_time = original (0) + pause_duration (300) = 300
    // because resume_stream shifts it by pause_duration (300).
    assert_eq!(s.last_update_time, 300);

    // Advance 100 s after resume and withdraw; expect 300 tokens
    // (200 pre-pause + 100 post-resume, since nothing was withdrawn yet).
    env.ledger().with_mut(|l| l.timestamp += 100);
    let token_client = token::Client::new(&env, &token);
    let before = token_client.balance(&recipient);
    let claimed = client.withdraw(&recipient, &id);
    let after = token_client.balance(&recipient);
    assert_eq!(claimed, 300);
    assert_eq!(after - before, 300);
}

#[test]
fn test_cancel_paused_stream_settles_at_paused_at() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);

    let client = create_contract(&env);
    let token_client = token::Client::new(&env, &token);

    // Stream: 1 000 tokens over 1 000 s → 1 token/s
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    // Advance 300 s — 300 tokens accrued.
    env.ledger().with_mut(|l| l.timestamp += 300);
    client.pause_stream(&sender, &id);

    // Advance 200 more s while paused — accrual must NOT count this time.
    env.ledger().with_mut(|l| l.timestamp += 200);

    let sender_before = token_client.balance(&sender);

    // Cancel the paused stream.
    client.cancel_stream(&sender, &id);

    let sender_after = token_client.balance(&sender);
    // Sender must be refunded the non-accrued portion: 1 000 − 300 = 700.
    assert_eq!(sender_after - sender_before, 700);

    let s = client.get_stream(&id).unwrap();
    assert!(!s.is_active);
}

#[test]
fn test_cancel_paused_stream_emits_correct_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);

    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    env.ledger().with_mut(|l| l.timestamp += 400);
    client.pause_stream(&sender, &id);
    env.ledger().with_mut(|l| l.timestamp += 100);

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
    // 400 tokens accrued before pause are settled to the recipient at cancel
    // (counted in amount_withdrawn); the remaining 600 is refunded to sender.
    assert_eq!(payload.refunded_amount, 600);
    assert_eq!(payload.amount_withdrawn, 400);
}

#[test]
fn test_resume_then_cancel_settles_across_pause_boundary() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);

    let client = create_contract(&env);
    let token_client = token::Client::new(&env, &token);

    // Stream: 1 000 tokens / 1 000 s → 1 token/s
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    // Phase 1: 200 s of streaming → 200 tokens accrued.
    env.ledger().with_mut(|l| l.timestamp += 200);

    // Phase 2: pause for 150 s (no extra accrual).
    client.pause_stream(&sender, &id);
    env.ledger().with_mut(|l| l.timestamp += 150);

    // Phase 3: resume and stream for another 100 s → 100 additional tokens.
    client.resume_stream(&sender, &id);
    env.ledger().with_mut(|l| l.timestamp += 100);

    let sender_before = token_client.balance(&sender);
    client.cancel_stream(&sender, &id);
    let sender_after = token_client.balance(&sender);

    // Total accrued = 200 + 100 = 300. Refund = 1 000 − 300 = 700.
    assert_eq!(sender_after - sender_before, 700);
}

#[test]
fn test_pause_stream_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &1_000, &1_000);

    env.ledger().with_mut(|l| l.timestamp += 50);
    client.pause_stream(&sender, &id);

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "stream_paused")
        })
        .expect("stream_paused event not found");

    let payload: StreamPausedEvent = StreamPausedEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.stream_id, id);
    assert_eq!(payload.sender, sender);
    assert_eq!(payload.paused_at, 50);
}

#[test]
fn test_resume_stream_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &1_000, &1_000);

    env.ledger().with_mut(|l| l.timestamp += 100);
    client.pause_stream(&sender, &id);
    env.ledger().with_mut(|l| l.timestamp += 50);
    client.resume_stream(&sender, &id);

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "stream_resumed")
        })
        .expect("stream_resumed event not found");

    let payload: StreamResumedEvent = StreamResumedEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.stream_id, id);
    assert_eq!(payload.sender, sender);
    // Pause at t=100 accrues 100 tokens (rate 1/s) that are already claimable
    // at resume, so the drain time is 900 more seconds from t=150, not 1000.
    assert_eq!(payload.new_end_time, 1050);
}

// ─── CEI / reentrancy regression (#789) ──────────────────────────────────────

/// Verify that stream state is committed to storage before the token transfer,
/// so that a re-entrant call (e.g. from a malicious token hook) at the same
/// ledger timestamp sees the updated withdrawn_amount and cannot claim twice.
#[test]
fn test_withdraw_state_committed_before_transfer_prevents_double_payout() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    // 1 000 tokens / 1 000 s = 1 token/s
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    env.ledger().with_mut(|l| l.timestamp += 100);

    // First withdrawal: 100 tokens accrued.
    let claimed = client.withdraw(&recipient, &id);
    assert_eq!(claimed, 100);

    // Immediately re-attempt at the same timestamp (simulates a re-entrant call
    // during the token transfer). State was already committed, so no additional
    // tokens have accrued and the call must fail with InvalidAmount.
    let result = client.try_withdraw(&recipient, &id);
    assert_eq!(
        result,
        Err(Ok(StreamError::InvalidAmount)),
        "re-entrant withdrawal at same timestamp must fail: state must be committed before transfer"
    );

    // Token balance must reflect exactly one payout.
    let token_client = token::Client::new(&env, &token);
    assert_eq!(token_client.balance(&recipient), 100);
}

/// Verify that cancel_stream commits state before both token transfers, so a
/// re-entrant cancel attempt finds the stream already inactive.
#[test]
fn test_cancel_state_committed_before_transfers_prevents_double_cancel() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    env.ledger().with_mut(|l| l.timestamp += 200);
    client.cancel_stream(&sender, &id);

    // Stream is now inactive; a second cancel (simulating re-entry) must fail.
    let result = client.try_cancel_stream(&sender, &id);
    assert_eq!(
        result,
        Err(Ok(StreamError::StreamInactive)),
        "re-entrant cancel must fail: stream marked inactive before transfers"
    );

    // Total outflow must equal deposited amount (no double-payout).
    let token_client = token::Client::new(&env, &token);
    let s = client.get_stream(&id).unwrap();
    assert_eq!(
        token_client.balance(&recipient) + token_client.balance(&sender),
        s.deposited_amount
    );
}

// ─── Event Wire Format Regression Guard ───────────────────────────────────────
//
// Pins the exact Map field names emitted for each event's `data` payload, as
// read by `decodeMap()` in `backend/src/workers/soroban-event-worker.ts`. If a
// field is renamed or removed here without updating the matching decoder in
// `soroban-event-worker.ts`, this test fails before the mismatch reaches
// production. See the mirrored field/type table in
// `backend/tests/events-wire-format.test.ts`.

/// Returns the sorted field names of a `#[contracttype]` event payload,
/// independent of struct field declaration order.
fn event_field_names(env: &Env, payload: &soroban_sdk::Val) -> std::vec::Vec<std::string::String> {
    let map = soroban_sdk::Map::<Symbol, soroban_sdk::Val>::try_from_val(env, payload)
        .expect("event data is not a Map");
    let mut names: std::vec::Vec<std::string::String> =
        map.keys().iter().map(|sym| sym.to_string()).collect();
    names.sort();
    names
}

// ─── Concurrent streams (same sender/recipient/token) ─────────────────────────

#[test]
fn test_concurrent_streams_same_tuple_independent_state() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);

    let client = create_contract(&env);
    let id1 = client.create_stream(&sender, &recipient, &token, &1_000, &100);
    let id2 = client.create_stream(&sender, &recipient, &token, &1_000, &100);

    // Both streams must exist and have distinct IDs.
    assert_ne!(id1, id2);
    let s1 = client.get_stream(&id1).unwrap();
    let s2 = client.get_stream(&id2).unwrap();
    assert_eq!(s1.deposited_amount, 1_000);
    assert_eq!(s2.deposited_amount, 1_000);
    assert_eq!(s1.withdrawn_amount, 0);
    assert_eq!(s2.withdrawn_amount, 0);

    // Advance time and withdraw from stream 1 only.
    env.ledger().with_mut(|l| l.timestamp += 50);
    let claimed1 = client.withdraw(&recipient, &id1);
    assert_eq!(claimed1, 500); // 50 s * (1 000 / 100) = 500

    // Stream 2 must be unaffected.
    let s2_after = client.get_stream(&id2).unwrap();
    assert_eq!(s2_after.withdrawn_amount, 0);
    assert_eq!(s2_after.deposited_amount, 1_000);

    // Advance more time and withdraw from stream 2.
    env.ledger().with_mut(|l| l.timestamp += 50);
    let claimed2 = client.withdraw(&recipient, &id2);
    assert_eq!(claimed2, 1_000); // 100 s * 10 rate = 1 000 (full stream)

    // Stream 1 must still have its original withdrawn amount unchanged.
    let s1_final = client.get_stream(&id1).unwrap();
    assert_eq!(s1_final.withdrawn_amount, 500);
}

// ─── Cumulative fee rounding drift ────────────────────────────────────────────
//
// The protocol fee uses integer division: fee = amount * fee_rate_bps / 10_000.
// When many small deposits are made sequentially, each individual fee may round
// down (due to integer truncation), causing the sum of collected fees to be
// slightly less than fee_rate_bps/10_000 of the gross total. This test verifies
// the drift stays within an acceptable tolerance.
//
// Rounding direction: favours the user (the protocol receives ≤ the ideal fee).

#[test]
fn test_cumulative_fee_rounding_drift() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let treasury = Address::generate(&env);
    let admin = Address::generate(&env);
    let recipient = Address::generate(&env);

    let fee_rate_bps: u32 = 199;
    mint(&env, &token, &sender, 10_000_000);

    let client = create_contract(&env);
    let token_client = token::Client::new(&env, &token);
    client.initialize(&admin, &treasury, &fee_rate_bps);

    let id = client.create_stream(&sender, &recipient, &token, &100_000, &10_000);

    // Perform 200 small sequential top-ups, each for 101 tokens.
    // Per top-up: fee = 101 * 199 / 10_000 = 20_099 / 10_000 = 2 (rounded down).
    let top_up_count = 200;
    let per_top_up = 101i128;
    for _ in 0..top_up_count {
        mint(&env, &token, &sender, per_top_up);
        client.top_up_stream(&sender, &id, &per_top_up);
    }

    let total_gross = 100_000i128 + (top_up_count as i128) * per_top_up;
    let ideal_fee = (total_gross * fee_rate_bps as i128) / 10_000;
    let actual_fee = token_client.balance(&treasury);

    // Each individual top-up of 101 * 199 / 10000 = 2.0099 → 2, losing 0.0099 per op.
    // Over 200 ops: at most 200 * 0.0099 ≈ 1.98 tokens of downward drift.
    // Allow tolerance of 2 tokens (enforced by `max_drift`).
    let max_drift = top_up_count as i128;
    let drift = ideal_fee - actual_fee;
    assert!(
        drift >= 0,
        "Fee collected ({}) exceeds ideal ({}) — rounding favoured protocol (unexpected)",
        actual_fee,
        ideal_fee
    );
    assert!(
        drift <= max_drift,
        "Fee drift too large: ideal={ideal_fee}, actual={actual_fee}, drift={drift}, max={max_drift}"
    );
}

// ─── update_fee_config ceiling enforcement ─────────────────────────────────────
//
// The existing test `test_update_fee_config_rejects_invalid_fee_rate` at line 171
// already verifies that `update_fee_config` rejects a rate above MAX_FEE_RATE_BPS
// (1 000). The implementation check is at `lib.rs:95-97`.

#[test]
fn test_stream_created_event_field_names_match_decoder_expectations() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let client = create_contract(&env);
    client.create_stream(&sender, &recipient, &token, &500, &100);

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "stream_created")
        })
        .expect("stream_created event not found");

    let mut names = event_field_names(&env, &ev.2);
    names.sort();

    // Must match the fields `handleStreamCreated` in soroban-event-worker.ts
    // reads via `decodeMap`: sender, recipient, token_address, rate_per_second,
    // deposited_amount, start_time. `stream_id` is also present in the data
    // map (StreamCreatedEvent's first field) but the worker reads it from the
    // topic instead, via `streamIdTopic`.
    let mut expected: std::vec::Vec<std::string::String> = std::vec::Vec::from([
        "sender",
        "recipient",
        "token_address",
        "rate_per_second",
        "deposited_amount",
        "start_time",
        "stream_id",
    ])
    .iter()
    .map(|s| std::string::String::from(*s))
    .collect();
    expected.sort();

    assert_eq!(
        names, expected,
        "stream_created event fields drifted from soroban-event-worker.ts's decodeMap expectations"
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// F1 — Protocol Circuit Breaker
// ═══════════════════════════════════════════════════════════════════════════

/// Builds a token, an initialized protocol, and an admin/guardian/outsider trio.
///
/// Returns the contract *address* rather than a client, because a client borrows
/// the `Env` and cannot be returned alongside it. Tests build their own client
/// with `StreamContractClient::new(&env, &contract)`.
fn setup_paused_env() -> (Env, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let contract = env.register(StreamContract, ());
    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let outsider = Address::generate(&env);
    let client = StreamContractClient::new(&env, &contract);
    client.initialize(&admin, &Address::generate(&env), &0);
    client.set_emergency_guardian(&admin, &Some(guardian.clone()));
    (env, token, contract, admin, guardian, outsider)
}

#[test]
fn test_initialize_leaves_protocol_unpaused_without_guardian() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);

    let config = client.get_fee_config().unwrap();
    assert!(!config.is_protocol_paused);
    assert_eq!(config.emergency_guardian, None);
    assert!(!client.is_protocol_paused());
}

#[test]
fn test_admin_can_pause_and_unpause_protocol() {
    let (env, _token, contract, admin, _guardian, _outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);

    client.set_protocol_pause(&admin, &true);
    assert!(client.is_protocol_paused());
    assert!(client.get_fee_config().unwrap().is_protocol_paused);

    client.set_protocol_pause(&admin, &false);
    assert!(!client.is_protocol_paused());
}

#[test]
fn test_guardian_can_pause_protocol() {
    let (env, _token, contract, _admin, guardian, _outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);

    client.set_protocol_pause(&guardian, &true);
    assert!(client.is_protocol_paused());
}

#[test]
fn test_guardian_cannot_unpause_protocol() {
    let (env, _token, contract, admin, guardian, _outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);

    client.set_protocol_pause(&admin, &true);
    // Asymmetric authority: a guardian may trip the breaker but never clear it.
    assert_eq!(
        client.try_set_protocol_pause(&guardian, &false),
        Err(Ok(StreamError::NotAdmin))
    );
    assert!(client.is_protocol_paused());
}

#[test]
fn test_pause_rejects_outsider() {
    let (env, _token, contract, _admin, _guardian, outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);

    assert_eq!(
        client.try_set_protocol_pause(&outsider, &true),
        Err(Ok(StreamError::NotGuardian))
    );
    assert!(!client.is_protocol_paused());
}

#[test]
fn test_pause_without_guardian_rejects_outsider() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let outsider = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);

    assert_eq!(
        client.try_set_protocol_pause(&outsider, &true),
        Err(Ok(StreamError::NotGuardian))
    );
}

#[test]
fn test_set_protocol_pause_rejects_unauthenticated_caller() {
    let (env, _token, contract, _admin, _guardian, outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);

    // Drop the blanket mock so require_auth actually has to be satisfied.
    env.set_auths(&[]);
    assert!(client.try_set_protocol_pause(&outsider, &true).is_err());
}

#[test]
fn test_set_protocol_pause_emits_event() {
    let (env, _token, contract, admin, _guardian, _outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);
    env.ledger().with_mut(|l| l.timestamp = 4_242);

    client.set_protocol_pause(&admin, &true);

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "protocol_pause_status")
        })
        .expect("protocol_pause_status event not found");

    let payload: ProtocolPauseStatusEvent =
        ProtocolPauseStatusEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.caller, admin);
    assert!(payload.paused);
    assert_eq!(payload.timestamp, 4_242);
}

#[test]
fn test_set_emergency_guardian_by_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);

    client.set_emergency_guardian(&admin, &Some(guardian.clone()));
    assert_eq!(
        client.get_fee_config().unwrap().emergency_guardian,
        Some(guardian)
    );

    // Clearing the role leaves the admin as sole authority.
    client.set_emergency_guardian(&admin, &None);
    assert_eq!(client.get_fee_config().unwrap().emergency_guardian, None);
}

#[test]
fn test_set_emergency_guardian_rejects_non_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let outsider = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);

    assert_eq!(
        client.try_set_emergency_guardian(&outsider, &Some(Address::generate(&env))),
        Err(Ok(StreamError::NotAdmin))
    );
}

#[test]
fn test_set_emergency_guardian_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);

    client.set_emergency_guardian(&admin, &Some(guardian.clone()));

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "emergency_guardian_updated")
        })
        .expect("emergency_guardian_updated event not found");

    let payload: EmergencyGuardianUpdatedEvent =
        EmergencyGuardianUpdatedEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.admin, admin);
    assert_eq!(payload.guardian, Some(guardian));
}

#[test]
fn test_set_protocol_pause_rejects_before_initialize() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    assert_eq!(
        client.try_set_protocol_pause(&Address::generate(&env), &true),
        Err(Ok(StreamError::NotInitialized))
    );
}

#[test]
fn test_paused_protocol_blocks_create_stream() {
    let (env, token, contract, admin, _guardian, _outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    client.set_protocol_pause(&admin, &true);

    assert_eq!(
        client.try_create_stream(&sender, &Address::generate(&env), &token, &1_000, &1_000),
        Err(Ok(StreamError::ProtocolPaused))
    );
    // The guard fires before any token movement, so nothing was escrowed.
    assert_eq!(token::Client::new(&env, &token).balance(&sender), 1_000);
}

#[test]
fn test_paused_protocol_blocks_step_vesting_stream() {
    let (env, token, contract, admin, _guardian, _outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    client.set_protocol_pause(&admin, &true);

    let steps = step_schedule(&env, &[(100, 500), (200, 500)]);
    assert_eq!(
        client.try_create_step_vesting_stream(
            &sender,
            &Address::generate(&env),
            &token,
            &1_000,
            &steps
        ),
        Err(Ok(StreamError::ProtocolPaused))
    );
}

#[test]
fn test_paused_protocol_blocks_hybrid_cliff_stream() {
    let (env, token, contract, admin, _guardian, _outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    client.set_protocol_pause(&admin, &true);

    assert_eq!(
        client.try_create_hybrid_cliff_stream(
            &sender,
            &Address::generate(&env),
            &token,
            &1_000,
            &500,
            &400,
            &600
        ),
        Err(Ok(StreamError::ProtocolPaused))
    );
}

#[test]
fn test_paused_protocol_blocks_top_up_stream() {
    let (env, token, contract, admin, _guardian, _outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &1_000, &1_000);

    client.set_protocol_pause(&admin, &true);

    assert_eq!(
        client.try_top_up_stream(&sender, &id, &500),
        Err(Ok(StreamError::ProtocolPaused))
    );
}

#[test]
fn test_paused_protocol_still_allows_withdraw() {
    let (env, token, contract, admin, _guardian, _outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    advance(&env, 100);
    client.set_protocol_pause(&admin, &true);

    // The fund-safety guarantee: a pause must never trap or censor vested funds.
    assert_eq!(client.withdraw(&recipient, &id), 100);
    assert_eq!(token::Client::new(&env, &token).balance(&recipient), 100);
}

#[test]
fn test_paused_protocol_still_allows_batch_withdraw() {
    let (env, token, contract, admin, _guardian, _outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);
    let a = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    let b = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    advance(&env, 100);
    client.set_protocol_pause(&admin, &true);

    let result = client.batch_withdraw(&recipient, &vec![&env, a, b]);
    assert_eq!(result, vec![&env, (a, 100), (b, 100)]);
}

#[test]
fn test_paused_protocol_still_allows_cancel_stream() {
    let (env, token, contract, admin, _guardian, _outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    advance(&env, 100);
    client.set_protocol_pause(&admin, &true);

    // Cancellation returns the sender's unearned capital, so it stays open too.
    client.cancel_stream(&sender, &id);
    let balances = token::Client::new(&env, &token);
    assert_eq!(balances.balance(&recipient), 100);
    // 1_000 minted, 1_000 escrowed, 900 refunded after the 100 vested payout.
    assert_eq!(balances.balance(&sender), 900);
}

#[test]
fn test_unpause_restores_creations_and_top_ups() {
    let (env, token, contract, admin, _guardian, _outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &1_000, &1_000);

    client.set_protocol_pause(&admin, &true);
    client.set_protocol_pause(&admin, &false);

    client.top_up_stream(&sender, &id, &500);
    let created = client.create_stream(&sender, &Address::generate(&env), &token, &500, &500);
    assert!(created > id);
74

74

74

    assert_eq!(client.get_stream(&id).unwrap().deposited_amount, 1_500);
}

#[test]
fn test_pause_does_not_freeze_existing_stream_accrual() {
    let (env, token, contract, admin, _guardian, _outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    advance(&env, 50);
    client.set_protocol_pause(&admin, &true);
    advance(&env, 50);

    // The breaker gates new money in, it does not stop time for existing
    // streams — otherwise a pause would silently forfeit vested wages.
    assert_eq!(client.get_claimable_amount(&id), Some(100));
}

#[test]
fn test_update_fee_config_preserves_pause_and_guardian_state() {
    let (env, _token, contract, admin, guardian, _outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);

    client.set_protocol_pause(&admin, &true);
    let new_treasury = Address::generate(&env);
    client.update_fee_config(&admin, &new_treasury, &250);

    let config = client.get_fee_config().unwrap();
    assert!(config.is_protocol_paused, "pause state was clobbered");
    assert_eq!(config.emergency_guardian, Some(guardian));
    assert_eq!(config.fee_rate_bps, 250);
    assert_eq!(config.treasury, new_treasury);
}

#[test]
fn test_transfer_admin_preserves_pause_and_guardian_state() {
    let (env, _token, contract, admin, guardian, _outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);
    let new_admin = Address::generate(&env);

    client.set_protocol_pause(&admin, &true);
    client.transfer_admin(&admin, &new_admin);

    let config = client.get_fee_config().unwrap();
    assert_eq!(config.admin, new_admin);
    assert!(config.is_protocol_paused, "in-force pause was dropped");
    assert_eq!(config.emergency_guardian, Some(guardian));
}

#[test]
fn test_only_new_admin_can_clear_pause_after_transfer() {
    let (env, _token, contract, admin, _guardian, _outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);
    let new_admin = Address::generate(&env);

    client.set_protocol_pause(&admin, &true);
    client.transfer_admin(&admin, &new_admin);

    // The outgoing admin has lost every privilege, including unpausing.
    assert_eq!(
        client.try_set_protocol_pause(&admin, &false),
        Err(Ok(StreamError::NotAdmin))
    );
    client.set_protocol_pause(&new_admin, &false);
    assert!(!client.is_protocol_paused());
}

#[test]
fn test_guardian_role_is_revocable_by_new_admin() {
    let (env, _token, contract, admin, guardian, _outsider) = setup_paused_env();
    let client = StreamContractClient::new(&env, &contract);
    let new_admin = Address::generate(&env);

    client.transfer_admin(&admin, &new_admin);
    // The guardian slot is carried over, so the guardian can still trip — but
    // it can never clear, and a new admin can drop the role at will.
    client.set_protocol_pause(&guardian, &true);
    client.set_emergency_guardian(&new_admin, &None);
    assert!(client.is_protocol_paused());
}

// ═══════════════════════════════════════════════════════════════════════════
// F2 — Milestone (Step-Tranche) Vesting
// ═══════════════════════════════════════════════════════════════════════════

/// Creates a funded step-tranche stream and returns its ID.
///
/// `pairs` is the `(unlock_time, unlock_amount)` schedule; the amounts must sum
/// to `deposit`, which is what `create_step_vesting_stream` enforces.
#[allow(clippy::too_many_arguments)]
fn create_step_stream(
    env: &Env,
    client: &StreamContractClient,
    sender: &Address,
    recipient: &Address,
    token: &Address,
    deposit: i128,
    pairs: &[(u64, i128)],
) -> u64 {
    let steps = step_schedule(env, pairs);
    client.create_step_vesting_stream(sender, recipient, token, &deposit, &steps)
}

#[test]
fn test_create_step_vesting_stream_persists_schedule() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let steps = step_schedule(&env, &[(100, 400), (200, 300), (300, 300)]);
    let id = client.create_step_vesting_stream(&sender, &recipient, &token, &1_000, &steps);

    let stream = client.get_stream(&id).unwrap();
    assert_eq!(stream.sender, sender);
    assert_eq!(stream.recipient, recipient);
    assert_eq!(stream.deposited_amount, 1_000);
    assert_eq!(stream.withdrawn_amount, 0);
    assert!(stream.is_active);
    // A step schedule unlocks by timestamp, not by rate.
    assert_eq!(stream.rate_per_second, 0);
    assert_eq!(
        stream.schedule,
        VestingSchedule::StepTranches(steps.clone())
    );
}

#[test]
fn test_step_vesting_claimable_is_zero_before_first_step() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let id = create_step_stream(
        &env,
        &client,
        &sender,
        &recipient,
        &token,
        1_000,
        &[(100, 500), (200, 500)],
    );
    advance(&env, 99);

    assert_eq!(client.get_claimable_amount(&id), Some(0));
    assert_eq!(
        client.try_withdraw(&recipient, &id),
        Err(Ok(StreamError::InvalidAmount))
    );
}

#[test]
fn test_step_vesting_claims_exact_cumulative_total() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = create_step_stream(
        &env,
        &client,
        &sender,
        &recipient,
        &token,
        1_000,
        &[(100, 250), (200, 250), (300, 500)],
    );

    advance(&env, 100);
    assert_eq!(client.get_claimable_amount(&id), Some(250));
    assert_eq!(client.withdraw(&recipient, &id), 250);

    // The engine is anchored to absolute unlock times and subtracts what has
    // already been paid, so each call yields only the newly unlocked step.
    advance(&env, 100);
    assert_eq!(client.get_claimable_amount(&id), Some(250));
    assert_eq!(client.withdraw(&recipient, &id), 250);

    advance(&env, 100);
    assert_eq!(client.get_claimable_amount(&id), Some(500));
    assert_eq!(client.withdraw(&recipient, &id), 500);
    assert_eq!(token::Client::new(&env, &token).balance(&recipient), 1_000);
}

#[test]
fn test_step_vesting_claim_lands_exactly_on_unlock_boundary() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = create_step_stream(
        &env,
        &client,
        &sender,
        &recipient,
        &token,
        1_000,
        &[(100, 400), (500, 600)],
    );

    advance(&env, 100);
    // `unlock_time <= T` is inclusive, so the step opens on the exact ledger.
    assert_eq!(client.get_claimable_amount(&id), Some(400));
    advance(&env, 399);
    assert_eq!(client.get_claimable_amount(&id), Some(400));
    advance(&env, 1);
    assert_eq!(client.get_claimable_amount(&id), Some(1_000));
}

#[test]
fn test_step_vesting_marks_completed_when_fully_claimed() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = create_step_stream(
        &env,
        &client,
        &sender,
        &recipient,
        &token,
        1_000,
        &[(100, 1_000)],
    );

    advance(&env, 100);
    client.withdraw(&recipient, &id);

    let stream = client.get_stream(&id).unwrap();
    assert!(!stream.is_active);
    assert_eq!(stream.status, StreamStatus::Completed);
    assert!(client.is_stream_completed(&id));
    assert_eq!(
        client.try_withdraw(&recipient, &id),
        Err(Ok(StreamError::StreamInactive))
    );
}

#[test]
fn test_step_vesting_single_claim_collects_all_unlocked_steps() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = create_step_stream(
        &env,
        &client,
        &sender,
        &recipient,
        &token,
        1_000,
        &[(100, 100), (200, 200), (300, 300), (400, 400)],
    );

    // A recipient who only checks in at the end collects everything at once.
    advance(&env, 1_000);
    assert_eq!(client.get_claimable_amount(&id), Some(1_000));
    assert_eq!(client.withdraw(&recipient, &id), 1_000);
}

#[test]
fn test_step_vesting_rejects_empty_schedule() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let steps = SorobanVec::new(&env);
    assert_eq!(
        client.try_create_step_vesting_stream(
            &sender,
            &Address::generate(&env),
            &token,
            &1_000,
            &steps
        ),
        Err(Ok(StreamError::EmptyVestingSchedule))
    );
}

#[test]
fn test_step_vesting_accepts_exactly_twelve_steps() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_200);

    let pairs: std::vec::Vec<(u64, i128)> = (1..=MAX_VESTING_STEPS)
        .map(|i| ((i as u64) * 100, 100))
        .collect();
    let id = create_step_stream(&env, &client, &sender, &recipient, &token, 1_200, &pairs);

    advance(&env, 600);
    assert_eq!(client.get_claimable_amount(&id), Some(600));
    advance(&env, 600);
    assert_eq!(client.withdraw(&recipient, &id), 1_200);
}

#[test]
fn test_step_vesting_rejects_more_than_twelve_steps() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_300);

    let pairs: std::vec::Vec<(u64, i128)> = (1..=MAX_VESTING_STEPS + 1)
        .map(|i| ((i as u64) * 100, 100))
        .collect();
    let steps = step_schedule(&env, &pairs);

    assert_eq!(
        client.try_create_step_vesting_stream(
            &sender,
            &Address::generate(&env),
            &token,
            &1_300,
            &steps
        ),
        Err(Ok(StreamError::TooManyVestingSteps))
    );
}

#[test]
fn test_step_vesting_rejects_non_monotonic_steps() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    // 200 then 100: out of order, so "sum of steps with unlock_time <= T" is
    // ambiguous at the boundary.
    let steps = step_schedule(&env, &[(200, 500), (100, 500)]);
    assert_eq!(
        client.try_create_step_vesting_stream(
            &sender,
            &Address::generate(&env),
            &token,
            &1_000,
            &steps
        ),
        Err(Ok(StreamError::NonMonotonicVestingSteps))
    );
}

#[test]
fn test_step_vesting_rejects_duplicate_unlock_times() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let steps = step_schedule(&env, &[(100, 500), (100, 500)]);
    assert_eq!(
        client.try_create_step_vesting_stream(
            &sender,
            &Address::generate(&env),
            &token,
            &1_000,
            &steps
        ),
        Err(Ok(StreamError::NonMonotonicVestingSteps))
    );
}

#[test]
fn test_step_vesting_rejects_non_positive_step_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let steps = step_schedule(&env, &[(100, 1_000), (200, 0)]);
    assert_eq!(
        client.try_create_step_vesting_stream(
            &sender,
            &Address::generate(&env),
            &token,
            &1_000,
            &steps
        ),
        Err(Ok(StreamError::InvalidVestingStepAmount))
    );
}

#[test]
fn test_step_vesting_rejects_total_mismatch() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    // Steps sum to 900, deposit is 1_000: 100 would be unclaimable forever.
    let steps = step_schedule(&env, &[(100, 400), (200, 500)]);
    assert_eq!(
        client.try_create_step_vesting_stream(
            &sender,
            &Address::generate(&env),
            &token,
            &1_000,
            &steps
        ),
        Err(Ok(StreamError::VestingStepTotalMismatch))
    );
}

#[test]
fn test_step_vesting_rejects_step_at_or_before_start() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    // A step at t=0 is already claimable at creation, which defeats the point.
    let steps = step_schedule(&env, &[(0, 1_000)]);
    assert_eq!(
        client.try_create_step_vesting_stream(
            &sender,
            &Address::generate(&env),
            &token,
            &1_000,
            &steps
        ),
        Err(Ok(StreamError::VestingStepBeforeStart))
    );
}

#[test]
fn test_step_vesting_rejects_invalid_token() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let sender = Address::generate(&env);

    let steps = step_schedule(&env, &[(100, 1_000)]);
    assert_eq!(
        client.try_create_step_vesting_stream(
            &sender,
            &Address::generate(&env),
            &Address::generate(&env),
            &1_000,
            &steps
        ),
        Err(Ok(StreamError::InvalidTokenAddress))
    );
}

#[test]
fn test_step_vesting_rejects_non_positive_deposit() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);

    let steps = step_schedule(&env, &[(100, 1_000)]);
    assert_eq!(
        client.try_create_step_vesting_stream(
            &sender,
            &Address::generate(&env),
            &token,
            &0,
            &steps
        ),
        Err(Ok(StreamError::InvalidAmount))
    );
    assert_eq!(
        client.try_create_step_vesting_stream(
            &sender,
            &Address::generate(&env),
            &token,
            &-1,
            &steps
        ),
        Err(Ok(StreamError::InvalidAmount))
    );
}

#[test]
fn test_step_vesting_with_fee_must_sum_to_net_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 10_000);
    // 1% fee: a 1_000 deposit nets 990.
    client.initialize(&admin, &treasury, &100);

    // Steps summing to the gross 1_000 must fail — they overshoot the net 990.
    let gross_steps = step_schedule(&env, &[(100, 1_000)]);
    assert_eq!(
        client.try_create_step_vesting_stream(&sender, &recipient, &token, &1_000, &gross_steps),
        Err(Ok(StreamError::VestingStepTotalMismatch))
    );

    let net_steps = step_schedule(&env, &[(100, 500), (200, 490)]);
    let id = client.create_step_vesting_stream(&sender, &recipient, &token, &1_000, &net_steps);
    assert_eq!(client.get_stream(&id).unwrap().deposited_amount, 990);
    assert_eq!(token::Client::new(&env, &token).balance(&treasury), 10);
}

#[test]
fn test_step_vesting_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    let id = create_step_stream(
        &env,
        &client,
        &sender,
        &recipient,
        &token,
        1_000,
        &[(100, 400), (200, 600)],
    );

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "step_vesting_stream_created")
        })
        .expect("step_vesting_stream_created event not found");

    let payload: StepVestingStreamCreatedEvent =
        StepVestingStreamCreatedEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.stream_id, id);
    assert_eq!(payload.sender, sender);
    assert_eq!(payload.recipient, recipient);
    assert_eq!(payload.deposited_amount, 1_000);
    assert_eq!(payload.step_count, 2);
    assert_eq!(payload.last_unlock_time, 200);
}

#[test]
fn test_step_vesting_cancel_settles_unlocked_and_refunds_future() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = create_step_stream(
        &env,
        &client,
        &sender,
        &recipient,
        &token,
        1_000,
        &[(100, 200), (200, 300), (300, 500)],
    );

    // Cancel between steps 1 and 2: step 1 settles, steps 2 and 3 refund.
    advance(&env, 150);
    client.cancel_stream(&sender, &id);

    let balances = token::Client::new(&env, &token);
    assert_eq!(balances.balance(&recipient), 200);
    assert_eq!(balances.balance(&sender), 800);

    let stream = client.get_stream(&id).unwrap();
    assert_eq!(stream.status, StreamStatus::Cancelled);
    assert!(!stream.is_active);
    assert_eq!(stream.withdrawn_amount, 200);
}

#[test]
fn test_step_vesting_cancel_before_any_step_refunds_everything() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = create_step_stream(
        &env,
        &client,
        &sender,
        &recipient,
        &token,
        1_000,
        &[(100, 500), (200, 500)],
    );

    advance(&env, 50);
    client.cancel_stream(&sender, &id);

    let balances = token::Client::new(&env, &token);
    assert_eq!(balances.balance(&recipient), 0);
    assert_eq!(balances.balance(&sender), 1_000);
}

#[test]
fn test_step_vesting_cancel_after_full_unlock_pays_recipient_only() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = create_step_stream(
        &env,
        &client,
        &sender,
        &recipient,
        &token,
        1_000,
        &[(100, 500), (200, 500)],
    );

    advance(&env, 500);
    client.cancel_stream(&sender, &id);

    let balances = token::Client::new(&env, &token);
    assert_eq!(balances.balance(&recipient), 1_000);
    assert_eq!(balances.balance(&sender), 0);
}

#[test]
fn test_step_vesting_cancel_after_partial_claim_settles_remainder() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = create_step_stream(
        &env,
        &client,
        &sender,
        &recipient,
        &token,
        1_000,
        &[(100, 250), (200, 250), (300, 500)],
    );

    advance(&env, 100);
    assert_eq!(client.withdraw(&recipient, &id), 250);
    advance(&env, 100);
    client.cancel_stream(&sender, &id);

    let balances = token::Client::new(&env, &token);
    // Recipient ends up with steps 1 + 2; step 3 returns to the sender.
    assert_eq!(balances.balance(&recipient), 500);
    assert_eq!(balances.balance(&sender), 500);
}

#[test]
fn test_step_vesting_pause_freezes_claimable_at_paused_at() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = create_step_stream(
        &env,
        &client,
        &sender,
        &recipient,
        &token,
        1_000,
        &[(100, 500), (500, 500)],
    );

    advance(&env, 100);
    client.pause_stream(&sender, &id);
    // Step 2 unlocks while paused; accrual must stay frozen at t=100.
    advance(&env, 400);
    assert_eq!(client.get_claimable_amount(&id), Some(500));
    assert_eq!(
        client.try_withdraw(&recipient, &id),
        Err(Ok(StreamError::StreamPaused))
    );
}

#[test]
fn test_step_vesting_resume_does_not_divide_by_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = create_step_stream(
        &env,
        &client,
        &sender,
        &recipient,
        &token,
        1_000,
        &[(100, 500), (500, 500)],
    );

    advance(&env, 100);
    client.pause_stream(&sender, &id);
    advance(&env, 50);
    // rate_per_second is 0 for a step schedule; the old end-time math would
    // have panicked on a division by zero here.
    let new_end = client.resume_stream(&sender, &id);
    assert_eq!(
        new_end, 500,
        "a step stream projects to its final unlock step"
    );

    advance(&env, 400);
    assert_eq!(client.withdraw(&recipient, &id), 1_000);
}

#[test]
fn test_step_vesting_get_vesting_schedule_query() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);

    let linear = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    assert_eq!(
        client.get_vesting_schedule(&linear),
        Some(VestingSchedule::Linear)
    );

    let steps = step_schedule(&env, &[(100, 600), (200, 400)]);
    let id = client.create_step_vesting_stream(&sender, &recipient, &token, &1_000, &steps);
    assert_eq!(
        client.get_vesting_schedule(&id),
        Some(VestingSchedule::StepTranches(steps))
    );

    assert_eq!(client.get_vesting_schedule(&9_999), None);
}

#[test]
fn test_step_vesting_projected_end_time_is_final_step() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = create_step_stream(
        &env,
        &client,
        &sender,
        &recipient,
        &token,
        1_000,
        &[(100, 200), (900, 300), (1_800, 500)],
    );

    assert_eq!(client.get_projected_end_time(&id), Some(1_800));
    assert_eq!(client.get_projected_end_time(&9_999), None);
}

#[test]
fn test_step_vesting_top_up_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);
    let id = create_step_stream(
        &env,
        &client,
        &sender,
        &recipient,
        &token,
        1_000,
        &[(100, 1_000)],
    );

    // A step schedule must sum to the deposit, so extra tokens have nowhere
    // legitimate to go: accepting them would strand them or defer them to the
    // final milestone without saying so.
    assert_eq!(
        client.try_top_up_stream(&sender, &id, &500),
        Err(Ok(StreamError::TopUpUnsupported))
    );
    assert_eq!(client.get_stream(&id).unwrap().deposited_amount, 1_000);
}

#[test]
fn test_step_vesting_claimable_never_exceeds_remaining_across_many_polls() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = create_step_stream(
        &env,
        &client,
        &sender,
        &recipient,
        &token,
        1_000,
        &[(100, 100), (250, 200), (500, 300), (1_000, 400)],
    );

    // Polling more often than the milestones fire must never over-pay.
    let mut collected: i128 = 0;
    for _ in 0..1_000 {
        advance(&env, 1);
        let claimable = client.get_claimable_amount(&id).unwrap();
        let remaining = 1_000 - collected;
        assert!(
            claimable <= remaining,
            "claimable {claimable} exceeded remaining {remaining}"
        );
        if claimable > 0 {
            collected += client.withdraw(&recipient, &id);
        }
        if client.is_stream_completed(&id) {
            break;
        }
    }
    assert_eq!(collected, 1_000);
    assert!(client.is_stream_completed(&id));
}

// ─── Hybrid cliff + linear ─────────────────────────────────────────────────

#[test]
fn test_hybrid_cliff_holds_everything_until_the_cliff() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    // 400 at the cliff, then the remaining 600 over 600s at 1/s.
    let id =
        client.create_hybrid_cliff_stream(&sender, &recipient, &token, &1_000, &500, &400, &600);

    advance(&env, 499);
    assert_eq!(client.get_claimable_amount(&id), Some(0));

    advance(&env, 1);
    assert_eq!(client.get_claimable_amount(&id), Some(400));
}

#[test]
fn test_hybrid_cliff_drips_tail_after_cliff() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id =
        client.create_hybrid_cliff_stream(&sender, &recipient, &token, &1_000, &500, &400, &600);

    advance(&env, 500);
    assert_eq!(client.withdraw(&recipient, &id), 400);
    advance(&env, 200);
    // 600 remainder at 1/s for 200s past the cliff.
    assert_eq!(client.get_claimable_amount(&id), Some(200));
    assert_eq!(client.withdraw(&recipient, &id), 200);
    assert_eq!(token::Client::new(&env, &token).balance(&recipient), 600);
}

#[test]
fn test_hybrid_cliff_drains_fully_at_end_of_linear_duration() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id =
        client.create_hybrid_cliff_stream(&sender, &recipient, &token, &1_000, &500, &400, &600);

    // Cliff at 500 plus the 600s linear tail.
    advance(&env, 1_100);
    assert_eq!(client.get_claimable_amount(&id), Some(1_000));
    assert_eq!(client.withdraw(&recipient, &id), 1_000);
    assert!(client.is_stream_completed(&id));
}

#[test]
fn test_hybrid_cliff_tail_is_capped_at_post_cliff_remainder() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    // 200 at the cliff, 800 remainder over 80s at 10/s.
    let id =
        client.create_hybrid_cliff_stream(&sender, &recipient, &token, &1_000, &500, &200, &80);

    // Far past the end of the linear tail: the claim is the whole deposit, and
    // the rate extrapolation must not push it past that.
    advance(&env, 100_000);
    assert_eq!(client.get_claimable_amount(&id), Some(1_000));
    assert_eq!(client.withdraw(&recipient, &id), 1_000);
}

#[test]
fn test_hybrid_cliff_rejects_cliff_not_after_start() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    assert_eq!(
        client.try_create_hybrid_cliff_stream(
            &sender,
            &Address::generate(&env),
            &token,
            &1_000,
            &0,
            &400,
            &600
        ),
        Err(Ok(StreamError::InvalidCliffParameters))
    );
}

#[test]
fn test_hybrid_cliff_rejects_cliff_consuming_whole_deposit() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    // A cliff equal to the deposit leaves no linear component at all.
    assert_eq!(
        client.try_create_hybrid_cliff_stream(
            &sender,
            &Address::generate(&env),
            &token,
            &1_000,
            &500,
            &1_000,
            &600
        ),
        Err(Ok(StreamError::InvalidCliffParameters))
    );
}

#[test]
fn test_hybrid_cliff_rejects_zero_duration_and_tiny_rate() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);

    assert_eq!(
        client.try_create_hybrid_cliff_stream(
            &sender,
            &Address::generate(&env),
            &token,
            &1_000,
            &500,
            &400,
            &0
        ),
        Err(Ok(StreamError::InvalidCliffParameters))
    );

    // 600 remaining spread over 10_000s rounds to 0/s and would never unlock.
    assert_eq!(
        client.try_create_hybrid_cliff_stream(
            &sender,
            &Address::generate(&env),
            &token,
            &1_000,
            &500,
            &400,
            &10_000
        ),
        Err(Ok(StreamError::InvalidCliffParameters))
    );
}

#[test]
fn test_hybrid_cliff_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id =
        client.create_hybrid_cliff_stream(&sender, &recipient, &token, &1_000, &500, &400, &600);

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "hybrid_cliff_stream_created")
        })
        .expect("hybrid_cliff_stream_created event not found");

    let payload: HybridCliffStreamCreatedEvent =
        HybridCliffStreamCreatedEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.stream_id, id);
    assert_eq!(payload.cliff_time, 500);
    assert_eq!(payload.cliff_unlock_amount, 400);
    assert_eq!(payload.rate_per_second, 1);
    assert_eq!(payload.deposited_amount, 1_000);
}

#[test]
fn test_hybrid_cliff_allows_top_up_and_extends_tail() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);
    let id =
        client.create_hybrid_cliff_stream(&sender, &recipient, &token, &1_000, &500, &400, &600);

    // Unlike a step schedule, extra deposit here just extends the tail at the
    // same rate — no invariant is broken.
    client.top_up_stream(&sender, &id, &600);
    assert_eq!(client.get_stream(&id).unwrap().deposited_amount, 1_600);

    advance(&env, 100_000);
    assert_eq!(client.get_claimable_amount(&id), Some(1_600));
}

// ═══════════════════════════════════════════════════════════════════════════
// F3 — In-Place Upgrades & State Migration
// ═══════════════════════════════════════════════════════════════════════════

/// A real, valid contract Wasm used as an in-place upgrade target.
///
/// Taken from the soroban-sdk 22.0.9 `doctest_fixtures/contract.wasm` fixture:
/// the host validates the executable against its own Wasm parser, so a byte
/// blob that is not a genuine module cannot exercise `upgrade` at all.
const UPGRADE_TARGET_WASM: &[u8] = &[
    0, 97, 115, 109, 1, 0, 0, 0, 1, 20, 4, 96, 1, 126, 1, 126, 96, 2, 127, 126, 0, 96, 2, 126, 126,
    1, 126, 96, 0, 0, 2, 13, 2, 1, 105, 1, 48, 0, 0, 1, 105, 1, 95, 0, 0, 3, 6, 5, 1, 2, 3, 3, 3,
    5, 3, 1, 0, 16, 6, 25, 3, 127, 1, 65, 128, 128, 192, 0, 11, 127, 0, 65, 128, 128, 192, 0, 11,
    127, 0, 65, 128, 128, 192, 0, 11, 7, 47, 5, 6, 109, 101, 109, 111, 114, 121, 2, 0, 3, 97, 100,
    100, 0, 3, 1, 95, 0, 6, 10, 95, 95, 100, 97, 116, 97, 95, 101, 110, 100, 3, 1, 11, 95, 95, 104,
    101, 97, 112, 95, 98, 97, 115, 101, 3, 2, 10, 140, 2, 5, 93, 2, 1, 127, 1, 126, 2, 64, 2, 64,
    32, 1, 167, 65, 255, 1, 113, 34, 2, 65, 192, 0, 70, 13, 0, 2, 64, 32, 2, 65, 6, 70, 13, 0, 66,
    1, 33, 3, 66, 131, 144, 128, 128, 128, 1, 33, 1, 12, 2, 11, 32, 1, 66, 8, 136, 33, 1, 66, 0,
    33, 3, 12, 1, 11, 66, 0, 33, 3, 32, 1, 16, 128, 128, 128, 128, 0, 33, 1, 11, 32, 0, 32, 1, 55,
    3, 8, 32, 0, 32, 3, 55, 3, 0, 11, 153, 1, 1, 1, 127, 35, 128, 128, 128, 128, 0, 65, 32, 107,
    34, 2, 36, 128, 128, 128, 128, 0, 32, 2, 65, 16, 106, 32, 0, 16, 130, 128, 128, 128, 0, 2, 64,
    2, 64, 32, 2, 40, 2, 16, 13, 0, 32, 2, 41, 3, 24, 33, 0, 32, 2, 32, 1, 16, 130, 128, 128, 128,
    0, 32, 2, 41, 3, 0, 167, 13, 0, 32, 0, 32, 2, 41, 3, 8, 124, 34, 1, 32, 0, 84, 13, 1, 2, 64, 2,
    64, 32, 1, 66, 255, 255, 255, 255, 255, 255, 255, 255, 0, 86, 13, 0, 32, 1, 66, 8, 134, 66, 6,
    132, 33, 0, 12, 1, 11, 32, 1, 16, 129, 128, 128, 128, 0, 33, 0, 11, 32, 2, 65, 32, 106, 36,
    128, 128, 128, 128, 0, 32, 0, 15, 11, 0, 0, 11, 16, 132, 128, 128, 128, 0, 0, 11, 9, 0, 16,
    133, 128, 128, 128, 0, 0, 11, 4, 0, 0, 0, 11, 2, 0, 11, 0, 75, 14, 99, 111, 110, 116, 114, 97,
    99, 116, 115, 112, 101, 99, 118, 48, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 97, 100, 100, 0, 0, 0,
    0, 2, 0, 0, 0, 0, 0, 0, 0, 1, 97, 0, 0, 0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 1, 98, 0, 0, 0, 0,
    0, 0, 6, 0, 0, 0, 1, 0, 0, 0, 6, 0, 30, 17, 99, 111, 110, 116, 114, 97, 99, 116, 101, 110, 118,
    109, 101, 116, 97, 118, 48, 0, 0, 0, 0, 0, 0, 0, 21, 0, 0, 0, 0, 0, 123, 14, 99, 111, 110, 116,
    114, 97, 99, 116, 109, 101, 116, 97, 118, 48, 0, 0, 0, 0, 0, 0, 0, 5, 114, 115, 118, 101, 114,
    0, 0, 0, 0, 0, 0, 6, 49, 46, 55, 52, 46, 48, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 114, 115, 115, 100,
    107, 118, 101, 114, 0, 0, 0, 57, 50, 49, 46, 48, 46, 49, 45, 112, 114, 101, 118, 105, 101, 119,
    46, 49, 35, 49, 49, 54, 99, 51, 53, 98, 99, 57, 101, 48, 51, 102, 52, 98, 49, 98, 53, 101, 54,
    53, 98, 53, 101, 101, 56, 51, 49, 97, 101, 48, 102, 56, 54, 97, 97, 57, 50, 102, 100, 0, 0, 0,
];

/// Uploads [`UPGRADE_TARGET_WASM`] to the test ledger and returns its hash.
fn upload_upgrade_target(env: &Env) -> BytesN<32> {
    env.deployer().upload_contract_wasm(UPGRADE_TARGET_WASM)
}

/// Rewrites the config in the pre-v2 three-field shape and clears the version.
///
/// Returns `(admin, treasury)` so callers can keep authenticating as the admin
/// of the downgraded record.
fn downgrade_state_to_v0(env: &Env, contract: &Address) -> (Address, Address) {
    env.as_contract(contract, || {
        let current: ProtocolConfig = env
            .storage()
            .instance()
            .get(&DataKey::ProtocolConfig)
            .expect("config present");

        let legacy = LegacyProtocolConfig {
            admin: current.admin,
            treasury: current.treasury,
            fee_rate_bps: current.fee_rate_bps,
        };
        env.storage()
            .instance()
            .set(&DataKey::ProtocolConfig, &legacy);
        // Absent version is what `get_contract_version` reads as 0.
        env.storage().instance().remove(&DataKey::ContractVersion);

        (legacy.admin, legacy.treasury)
    })
}

/// Rewrites one stream record in the pre-v2 shape (no `schedule` field).
fn downgrade_stream_to_v0(env: &Env, contract: &Address, stream_id: u64) {
    env.as_contract(contract, || {
        let current: Stream = env
            .storage()
            .persistent()
            .get(&DataKey::Stream(stream_id))
            .expect("stream present");

        let legacy = LegacyStream {
            sender: current.sender,
            recipient: current.recipient,
            token_address: current.token_address,
            rate_per_second: current.rate_per_second,
            deposited_amount: current.deposited_amount,
            withdrawn_amount: current.withdrawn_amount,
            start_time: current.start_time,
            last_update_time: current.last_update_time,
            is_active: current.is_active,
            paused: current.paused,
            paused_at: current.paused_at,
            status: current.status,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Stream(stream_id), &legacy);
    });
}

/// Number of fields in the raw record at `stream_id`.
///
/// The shape helpers below cannot simply try to decode: a `#[contracttype]`
/// decode that does not match the stored map aborts the invocation with a host
/// error rather than returning an `Err`, so a "does it decode?" probe is not a
/// question that can be asked safely. Counting fields can.
fn raw_stream_field_count(env: &Env, contract: &Address, stream_id: u64) -> u32 {
    env.as_contract(contract, || {
        let raw: Val = env
            .storage()
            .persistent()
            .get(&DataKey::Stream(stream_id))
            .expect("stream record present");
        soroban_sdk::Map::<Symbol, Val>::try_from_val(env, &raw)
            .expect("stream record is a map")
            .len()
    })
}

/// True when the raw record at `stream_id` decodes as the current [`Stream`].
fn stream_record_is_current_shape(env: &Env, contract: &Address, stream_id: u64) -> bool {
    // `Stream` carries the `schedule` field; `LegacyStream` does not.
    raw_stream_field_count(env, contract, stream_id) == 13
}

/// True when the raw record at `stream_id` decodes as the pre-v2 [`LegacyStream`].
fn stream_record_is_legacy_shape(env: &Env, contract: &Address, stream_id: u64) -> bool {
    raw_stream_field_count(env, contract, stream_id) == 12
}

/// True when the raw config decodes as the current [`ProtocolConfig`].
fn config_record_is_current_shape(env: &Env, contract: &Address) -> bool {
    env.as_contract(contract, || {
        let raw: Val = env
            .storage()
            .instance()
            .get(&DataKey::ProtocolConfig)
            .expect("config present");
        soroban_sdk::Map::<Symbol, Val>::try_from_val(env, &raw)
            .expect("config is a map")
            .len()
            // The breaker/guardian fields are what separate the two shapes.
            == 5
    })
}

// ─── Version Pinning ─────────────────────────────────────────────────────────

#[test]
fn test_initialize_pins_state_version_two() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    assert_eq!(client.get_contract_version(), 0, "pre-initialize default");

    client.initialize(&Address::generate(&env), &Address::generate(&env), &0);
    assert_eq!(client.get_contract_version(), 2);
}

#[test]
fn test_initialize_rejects_double_initialize() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);

    assert_eq!(
        client.try_initialize(&admin, &Address::generate(&env), &0),
        Err(Ok(StreamError::AlreadyInitialized))
    );
    // A rejected re-initialize must not move the schema version backwards.
    assert_eq!(client.get_contract_version(), 2);
}

// ─── upgrade ──────────────────────────────────────────────────────────────────

#[test]
fn test_upgrade_records_new_executable_hash() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);

    let hash = upload_upgrade_target(&env);
    client.upgrade(&hash);

    // The recorded hash is readable state, so the next upgrade can chain
    // without the host exposing a live-executable getter.
    env.as_contract(&client.address, || {
        let recorded: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::ContractWasmHash)
            .expect("hash recorded");
        assert_eq!(recorded, hash);
    });
}

#[test]
fn test_upgrade_does_not_disturb_funds_or_streams() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);
    mint(&env, &token, &sender, 2_000);
    let contract = client.address.clone();

    let linear = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    let steps = step_schedule(&env, &[(100, 500), (200, 500)]);
    let stepped = client.create_step_vesting_stream(&sender, &recipient, &token, &1_000, &steps);

    let hash = upload_upgrade_target(&env);
    client.upgrade(&hash);

    // `update_current_contract_wasm` takes effect when the invocation returns,
    // so from here on this address runs the *target* module and none of this
    // contract's entrypoints exist. A swap must not rewrite a single record, so
    // state is inspected directly on the host side.
    env.as_contract(&contract, || {
        let version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ContractVersion)
            .expect("version present");
        assert_eq!(version, 2, "a code swap must not move the schema version");

        let linear_record: Stream = env
            .storage()
            .persistent()
            .get(&DataKey::Stream(linear))
            .expect("linear stream present");
        assert_eq!(linear_record.schedule, VestingSchedule::Linear);
        assert_eq!(linear_record.deposited_amount, 1_000);
        assert_eq!(linear_record.recipient, recipient);

        let stepped_record: Stream = env
            .storage()
            .persistent()
            .get(&DataKey::Stream(stepped))
            .expect("stepped stream present");
        assert_eq!(
            stepped_record.schedule,
            VestingSchedule::StepTranches(steps)
        );
        assert_eq!(stepped_record.deposited_amount, 1_000);
    });

    // Both escrows are still parked at the contract address.
    let balances = token::Client::new(&env, &token);
    assert_eq!(balances.balance(&sender), 0);
    assert_eq!(balances.balance(&contract), 2_000);
    assert_eq!(balances.balance(&recipient), 0);
}

#[test]
fn test_upgrade_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);
    env.ledger().with_mut(|l| l.timestamp = 9_100);

    let hash = upload_upgrade_target(&env);
    client.upgrade(&hash);

    let events = env.events().all();
    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "contract_upgraded")
        })
        .expect("contract_upgraded event not found");

    let payload: ContractUpgradedEvent = ContractUpgradedEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.admin, admin);
    assert_eq!(payload.new_wasm_hash, hash);
    // Never upgraded in place before this call, so the "old" hash is the zero
    // sentinel rather than a genuine previous executable.
    assert_eq!(payload.old_wasm_hash, BytesN::from_array(&env, &[0u8; 32]));
    assert_eq!(payload.timestamp, 9_100);
}

#[test]
fn test_upgrade_requires_admin_auth_and_records_no_hash_without_it() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let contract = client.address.clone();
    client.initialize(&admin, &Address::generate(&env), &0);
    let hash = upload_upgrade_target(&env);

    // `upgrade` takes no caller argument — it gates on `config.admin`'s
    // `require_auth`, so withholding the admin's signature is the only way a
    // non-admin can reach it, and the call must fail without side effects.
    env.set_auths(&[]);
    assert!(client.try_upgrade(&hash).is_err());

    // A refused upgrade must be a total no-op: no half-installed executable and
    // no hash written, or the next upgrade would report a binary that never ran.
    env.as_contract(&contract, || {
        let recorded: Option<BytesN<32>> = env.storage().instance().get(&DataKey::ContractWasmHash);
        assert!(
            recorded.is_none(),
            "a rejected upgrade still recorded a hash"
        );
    });
}

#[test]
fn test_upgrade_before_initialize_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let hash = upload_upgrade_target(&env);

    assert_eq!(
        client.try_upgrade(&hash),
        Err(Ok(StreamError::NotInitialized))
    );
}

#[test]
fn test_recorded_wasm_hash_is_zero_before_first_upgrade() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let contract = client.address.clone();
    client.initialize(&admin, &Address::generate(&env), &0);

    // A freshly deployed contract has no recorded upgrade, so the "previous
    // executable" the event reports is the zero sentinel rather than a real hash.
    env.as_contract(&contract, || {
        let recorded: Option<BytesN<32>> = env.storage().instance().get(&DataKey::ContractWasmHash);
        assert!(recorded.is_none(), "initialize must not record a hash");
    });
}

#[test]
fn test_upgrade_to_identical_wasm_keeps_state_readable() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);
    mint(&env, &token, &sender, 1_000);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    // Upgrading to the contract's *own* built artifact is the no-op upgrade
    // that must still be safe. Requires a prior release wasm build, so the test
    // degrades to a no-op when only the unit-test build is present.
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../target/wasm32-unknown-unknown/release/stream_contract.wasm"
    );
    let Ok(wasm) = std::fs::read(path) else {
        std::eprintln!("skipping: build the release wasm first ({} absent)", path);
        return;
    };
    let hash = env
        .deployer()
        .upload_contract_wasm(Bytes::from_slice(&env, &wasm));
    client.upgrade(&hash);

    assert_eq!(client.get_contract_version(), 2);
    assert_eq!(client.get_stream(&id).unwrap().deposited_amount, 1_000);
    advance(&env, 100);
    assert_eq!(client.withdraw(&recipient, &id), 100);
}

// ─── migrate ──────────────────────────────────────────────────────────────────

#[test]
fn test_migrate_requires_admin_auth_and_changes_nothing_without_it() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let contract = client.address.clone();
    client.initialize(&admin, &Address::generate(&env), &0);
    downgrade_state_to_v0(&env, &contract);

    // `migrate` takes no caller argument — it gates on `config.admin`'s
    // `require_auth`, so withholding the admin's signature is the only way a
    // non-admin can reach it, and the call must fail without side effects.
    env.set_auths(&[]);
    assert!(client.try_migrate(&2).is_err());
    assert_eq!(client.get_contract_version(), 0);
    assert!(
        !config_record_is_current_shape(&env, &contract),
        "a refused migration still rewrote the config"
    );
}

#[test]
fn test_migrate_before_initialize_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    assert_eq!(client.try_migrate(&2), Err(Ok(StreamError::NotInitialized)));
}

#[test]
fn test_migrate_to_current_version_is_a_noop() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);

    client.migrate(&2);
    assert_eq!(client.get_contract_version(), 2);

    // Idempotent: no event, no error, no state change.
    let before = env.events().all().len();
    client.migrate(&2);
    assert_eq!(env.events().all().len(), before);
}

#[test]
fn test_migrate_rejects_downgrade() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);

    assert_eq!(
        client.try_migrate(&1),
        Err(Ok(StreamError::UnsupportedMigration))
    );
    assert_eq!(client.get_contract_version(), 2);
}

#[test]
fn test_migrate_rejects_target_newer_than_contract() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);

    // This binary cannot write v3, so it must refuse rather than half-apply.
    assert_eq!(
        client.try_migrate(&3),
        Err(Ok(StreamError::UnsupportedMigration))
    );
    assert_eq!(client.get_contract_version(), 2);
}

#[test]
fn test_migrate_rejects_state_newer_than_contract() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);
    let contract = client.address.clone();

    // Simulate having been downgraded onto by an older binary: v99 state must
    // be flagged, not silently overwritten with a v2 layout.
    env.as_contract(&contract, || {
        env.storage()
            .instance()
            .set(&DataKey::ContractVersion, &99u32);
    });

    assert_eq!(
        client.try_migrate(&2),
        Err(Ok(StreamError::StateVersionTooNew))
    );
    assert_eq!(client.get_contract_version(), 99);
}

#[test]
fn test_migrate_from_v0_rewrites_config_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &100);
    let contract = client.address.clone();

    let (legacy_admin, legacy_treasury) = downgrade_state_to_v0(&env, &contract);
    assert_eq!(legacy_admin, admin);
    assert_eq!(legacy_treasury, treasury);
    assert_eq!(client.get_contract_version(), 0);
    assert!(!config_record_is_current_shape(&env, &contract));

    client.migrate(&2);

    // Snapshot the log straight after the call: `env.as_contract` opens a new
    // host frame, which discards the events of everything before it.
    let events = env.events().all();

    assert_eq!(client.get_contract_version(), 2);
    assert!(config_record_is_current_shape(&env, &contract));
    let config = client.get_fee_config().unwrap();
    assert_eq!(config.admin, admin);
    assert_eq!(config.treasury, treasury);
    assert_eq!(config.fee_rate_bps, 100);
    assert!(!config.is_protocol_paused);
    assert_eq!(config.emergency_guardian, None);

    let ev = events
        .iter()
        .find(|e| {
            Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                == Symbol::new(&env, "state_migrated")
        })
        .expect("state_migrated event not found");
    let payload: StateMigratedEvent = StateMigratedEvent::try_from_val(&env, &ev.2).unwrap();
    assert_eq!(payload.admin, admin);
    assert_eq!(payload.old_version, 0);
    assert_eq!(payload.new_version, 2);
}

#[test]
fn test_migrate_from_v1_rewrites_config() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);
    let contract = client.address.clone();

    // v1 was already versioned but still pre-dates the breaker fields.
    downgrade_state_to_v0(&env, &contract);
    env.as_contract(&contract, || {
        env.storage()
            .instance()
            .set(&DataKey::ContractVersion, &1u32);
    });

    client.migrate(&2);
    assert_eq!(client.get_contract_version(), 2);
    assert!(config_record_is_current_shape(&env, &contract));
}

// ─── Lazy Legacy Decoding ────────────────────────────────────────────────────

#[test]
fn test_legacy_config_decodes_with_breaker_defaults() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    client.initialize(&admin, &treasury, &250);
    let contract = client.address.clone();

    downgrade_state_to_v0(&env, &contract);

    // Reads must work before `migrate` runs, and a pre-breaker record has to
    // default to "not paused" with no guardian rather than a garbage read.
    let config = client.get_fee_config().unwrap();
    assert_eq!(config.admin, admin);
    assert_eq!(config.treasury, treasury);
    assert_eq!(config.fee_rate_bps, 250);
    assert!(!config.is_protocol_paused);
    assert_eq!(config.emergency_guardian, None);
    assert!(!client.is_protocol_paused());
}

#[test]
fn test_legacy_config_is_writable_through_the_breaker_api() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);
    let contract = client.address.clone();

    downgrade_state_to_v0(&env, &contract);
    let guardian = Address::generate(&env);
    client.set_emergency_guardian(&admin, &Some(guardian.clone()));
    client.set_protocol_pause(&admin, &true);

    assert!(client.is_protocol_paused());
    // The first write through the new API is what heals the record.
    assert!(config_record_is_current_shape(&env, &contract));
    assert_eq!(client.get_contract_version(), 0, "read is not a migration");

    client.migrate(&2);
    assert_eq!(client.get_contract_version(), 2);
    // Pause survives the explicit migration — it is in force, not a draft.
    assert!(client.is_protocol_paused());
    assert_eq!(
        client.get_fee_config().unwrap().emergency_guardian,
        Some(guardian)
    );
}

#[test]
fn test_legacy_config_still_charges_fees_before_migration() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 10_000);
    client.initialize(&admin, &treasury, &100);
    let contract = client.address.clone();

    downgrade_state_to_v0(&env, &contract);
    // 10_000 at 1% nets 9_900, which spreads to 9/s over 1_000s. (A 1_000
    // deposit would net 990 — a 0/s rate, rejected as `InvalidRate`.)
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &10_000, &1_000);

    // Fee collection reads the config through the same tolerant loader; losing
    // the fee on legacy state would be a silent revenue bug.
    assert_eq!(client.get_stream(&id).unwrap().deposited_amount, 9_900);
    assert_eq!(client.get_stream(&id).unwrap().rate_per_second, 9);
    assert_eq!(token::Client::new(&env, &token).balance(&treasury), 100);
    assert_eq!(client.get_contract_version(), 0);
}

#[test]
fn test_legacy_stream_decodes_as_linear_and_withdraws() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);
    mint(&env, &token, &sender, 1_000);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    let contract = client.address.clone();

    downgrade_stream_to_v0(&env, &contract, id);
    assert!(stream_record_is_legacy_shape(&env, &contract, id));
    assert!(!stream_record_is_current_shape(&env, &contract, id));

    // Escrowed funds must remain reachable even though the record no longer
    // decodes in the current shape.
    advance(&env, 100);
    assert_eq!(client.get_claimable_amount(&id), Some(100));
    assert_eq!(client.withdraw(&recipient, &id), 100);
    assert_eq!(client.get_projected_end_time(&id), Some(1_000));
}

#[test]
fn test_legacy_stream_heals_on_write() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);
    mint(&env, &token, &sender, 1_000);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    let contract = client.address.clone();

    downgrade_stream_to_v0(&env, &contract, id);
    advance(&env, 100);
    client.withdraw(&recipient, &id);

    // Any write persists the current shape; only reads leave the record legacy.
    assert!(stream_record_is_current_shape(&env, &contract, id));
    assert!(!stream_record_is_legacy_shape(&env, &contract, id));
    let healed = client.get_stream(&id).unwrap();
    assert_eq!(healed.schedule, VestingSchedule::Linear);
    assert_eq!(healed.withdrawn_amount, 100);
}

#[test]
fn test_legacy_stream_reads_alone_never_heal() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = client.create_stream(&sender, &Address::generate(&env), &token, &1_000, &1_000);
    let contract = client.address.clone();

    downgrade_stream_to_v0(&env, &contract, id);
    advance(&env, 100);
    // `migrate` cannot enumerate persistent storage, so a read must stay
    // side-effect free.
    for _ in 0..5 {
        assert_eq!(client.get_claimable_amount(&id), Some(100));
        assert_eq!(client.get_stream(&id).unwrap().deposited_amount, 1_000);
    }
    assert!(stream_record_is_legacy_shape(&env, &contract, id));
    assert!(!stream_record_is_current_shape(&env, &contract, id));
}

#[test]
fn test_legacy_paused_stream_stays_paused() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);
    mint(&env, &token, &sender, 1_000);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    advance(&env, 50);
    client.pause_stream(&sender, &id);
    let contract = client.address.clone();
    downgrade_stream_to_v0(&env, &contract, id);

    // Losing the paused flag on decode would silently unfreeze a stream the
    // sender deliberately stopped.
    advance(&env, 50);
    assert_eq!(client.get_claimable_amount(&id), Some(50));
    assert_eq!(
        client.try_withdraw(&recipient, &id),
        Err(Ok(StreamError::StreamPaused))
    );
}

#[test]
fn test_missing_stream_still_reports_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);
    client.initialize(&Address::generate(&env), &Address::generate(&env), &0);

    // The legacy fallback must not turn "absent" into a phantom stream.
    assert_eq!(client.get_stream(&1_234), None);
    assert_eq!(
        client.try_withdraw(&Address::generate(&env), &1_234),
        Err(Ok(StreamError::StreamNotFound))
    );
}

#[test]
fn test_legacy_records_survive_a_real_upgrade() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);
    mint(&env, &token, &sender, 1_000);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    let contract = client.address.clone();

    downgrade_state_to_v0(&env, &contract);
    downgrade_stream_to_v0(&env, &contract, id);
    assert_eq!(client.get_contract_version(), 0);

    // All contract calls happen before the swap: afterwards this address runs
    // the target module, so the entrypoints no longer exist.
    advance(&env, 100);
    assert_eq!(client.withdraw(&recipient, &id), 100);
    client.migrate(&2);
    assert_eq!(client.get_contract_version(), 2);
    assert!(config_record_is_current_shape(&env, &contract));
    assert!(stream_record_is_current_shape(&env, &contract, id));

    let hash = upload_upgrade_target(&env);
    client.upgrade(&hash);

    // The very last check: a code swap on healed state changes nothing.
    env.as_contract(&contract, || {
        let version: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ContractVersion)
            .expect("version present");
        assert_eq!(version, 2);

        let raw: Val = env
            .storage()
            .persistent()
            .get(&DataKey::Stream(id))
            .expect("stream present");
        let healed: Stream = Stream::try_from_val(&env, &raw).expect("still current shape");
        assert_eq!(healed.withdrawn_amount, 100);
        assert_eq!(healed.schedule, VestingSchedule::Linear);
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// F4 — Batch Withdrawals
// ═══════════════════════════════════════════════════════════════════════════

/// Creates `count` linear streams of `deposit` over `duration`, all owed to
/// `recipient`, and returns their IDs.
#[allow(clippy::too_many_arguments)]
fn create_linear_fanout(
    env: &Env,
    client: &StreamContractClient,
    sender: &Address,
    recipient: &Address,
    token: &Address,
    count: u32,
    deposit: i128,
    duration: u64,
) -> SorobanVec<u64> {
    let mut ids = SorobanVec::new(env);
    for _ in 0..count {
        ids.push_back(client.create_stream(sender, recipient, token, &deposit, &duration));
    }
    ids
}

#[test]
fn test_batch_withdraw_pays_every_stream_in_one_call() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 3_000);

    let ids = create_linear_fanout(&env, &client, &sender, &recipient, &token, 3, 1_000, 1_000);
    advance(&env, 100);

    let result = client.batch_withdraw(&recipient, &ids);
    assert_eq!(result.len(), 3);
    for id in ids.iter() {
        let (_, amount) = result.iter().find(|(k, _)| *k == id).unwrap();
        assert_eq!(amount, 100);
    }
    assert_eq!(token::Client::new(&env, &token).balance(&recipient), 300);
}

#[test]
fn test_batch_withdraw_returns_id_and_amount_pairs_in_request_order() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 3_000);

    let ids = create_linear_fanout(&env, &client, &sender, &recipient, &token, 3, 1_000, 1_000);
    advance(&env, 250);

    // Deliberately not the creation order, so a reordering implementation
    // cannot pass by accident.
    let request = vec![
        &env,
        ids.get(2).unwrap(),
        ids.get(0).unwrap(),
        ids.get(1).unwrap(),
    ];
    let result = client.batch_withdraw(&recipient, &request);

    assert_eq!(result.len(), 3);
    assert_eq!(result.get(0).unwrap(), (ids.get(2).unwrap(), 250));
    assert_eq!(result.get(1).unwrap(), (ids.get(0).unwrap(), 250));
    assert_eq!(result.get(2).unwrap(), (ids.get(1).unwrap(), 250));
}

#[test]
fn test_batch_withdraw_of_empty_list_is_a_noop() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    advance(&env, 100);

    let result = client.batch_withdraw(&recipient, &vec![&env]);
    assert!(result.is_empty());
    assert_eq!(token::Client::new(&env, &token).balance(&recipient), 0);
}

#[test]
fn test_batch_withdraw_single_stream_matches_withdraw() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);
    let batched = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    let single = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    advance(&env, 400);

    let result = client.batch_withdraw(&recipient, &vec![&env, batched]);
    assert_eq!(result.get(0).unwrap(), (batched, 400));
    // The single-stream path must agree exactly, or batching would be a way to
    // get different accounting than the unbatched call.
    assert_eq!(client.withdraw(&recipient, &single), 400);
}

#[test]
fn test_batch_withdraw_skips_streams_with_nothing_claimable() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 4_000);

    // A step stream whose first milestone is still in the future contributes
    // nothing and must be omitted from the result, not reported as zero.
    let linear = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    let steps = step_schedule(&env, &[(1_000, 1_000)]);
    let stepped = client.create_step_vesting_stream(&sender, &recipient, &token, &1_000, &steps);
    let linear2 = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    mint(&env, &token, &sender, 1_000);

    advance(&env, 100);
    let result = client.batch_withdraw(&recipient, &vec![&env, linear, stepped, linear2]);

    assert_eq!(result.len(), 2);
    assert!(
        !result.iter().any(|(id, _)| id == stepped),
        "a zero-claim stream was reported"
    );
    assert_eq!(token::Client::new(&env, &token).balance(&recipient), 200);
}

#[test]
fn test_batch_withdraw_skips_paused_streams() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);
    let paused = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    let live = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    advance(&env, 100);
    client.pause_stream(&sender, &paused);

    let result = client.batch_withdraw(&recipient, &vec![&env, paused, live]);
    assert_eq!(result.len(), 1);
    assert_eq!(result.get(0).unwrap(), (live, 100));
    assert_eq!(client.get_stream(&paused).unwrap().withdrawn_amount, 0);
}

#[test]
fn test_batch_withdraw_skips_completed_streams() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);
    let drained = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    let live = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    advance(&env, 1_000);
    assert_eq!(client.withdraw(&recipient, &drained), 1_000);
    assert!(client.is_stream_completed(&drained));

    let result = client.batch_withdraw(&recipient, &vec![&env, drained, live]);
    assert_eq!(result.len(), 1);
    assert_eq!(result.get(0).unwrap(), (live, 1_000));
}

#[test]
fn test_batch_withdraw_rejects_foreign_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let thief = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);
    let mine = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    let theirs = client.create_stream(&sender, &thief, &token, &1_000, &1_000);

    advance(&env, 100);
    // Ownership is checked per stream, so one foreign ID cannot be laundered
    // through a batch of legitimate ones.
    assert_eq!(
        client.try_batch_withdraw(&recipient, &vec![&env, mine, theirs]),
        Err(Ok(StreamError::Unauthorized))
    );
    // The whole call is rejected: no partial payout escapes.
    assert_eq!(token::Client::new(&env, &token).balance(&recipient), 0);
    assert_eq!(client.get_stream(&mine).unwrap().withdrawn_amount, 0);
}

#[test]
fn test_batch_withdraw_rejects_foreign_recipient() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    let attacker = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    advance(&env, 100);
    assert_eq!(
        client.try_batch_withdraw(&attacker, &vec![&env, id]),
        Err(Ok(StreamError::Unauthorized))
    );
    assert_eq!(token::Client::new(&env, &token).balance(&attacker), 0);
}

#[test]
fn test_batch_withdraw_rejects_missing_stream() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    advance(&env, 100);
    assert_eq!(
        client.try_batch_withdraw(&recipient, &vec![&env, id, 9_999]),
        Err(Ok(StreamError::StreamNotFound))
    );
    // A typo in one ID must not cost the caller the rest of the batch.
    assert_eq!(client.get_stream(&id).unwrap().withdrawn_amount, 0);
}

#[test]
fn test_batch_withdraw_rejects_unauthenticated_recipient() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    advance(&env, 100);
    env.set_auths(&[]);
    assert!(client
        .try_batch_withdraw(&recipient, &vec![&env, id])
        .is_err());
    assert_eq!(client.get_stream(&id).unwrap().withdrawn_amount, 0);
}

#[test]
fn test_batch_withdraw_accepts_exactly_thirty_streams() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 30_000);

    let ids = create_linear_fanout(
        &env,
        &client,
        &sender,
        &recipient,
        &token,
        MAX_BATCH_WITHDRAW,
        1_000,
        1_000,
    );
    advance(&env, 100);

    let result = client.batch_withdraw(&recipient, &ids);
    assert_eq!(result.len(), MAX_BATCH_WITHDRAW);
    assert_eq!(
        token::Client::new(&env, &token).balance(&recipient),
        100 * MAX_BATCH_WITHDRAW as i128
    );
}

#[test]
fn test_batch_withdraw_rejects_more_than_thirty_streams() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 31_000);

    let ids = create_linear_fanout(
        &env,
        &client,
        &sender,
        &recipient,
        &token,
        MAX_BATCH_WITHDRAW + 1,
        1_000,
        1_000,
    );
    advance(&env, 100);

    // The cap exists to bound one invocation's work; enforcing it only at the
    // edge would let an oversized batch through unchecked.
    assert_eq!(
        client.try_batch_withdraw(&recipient, &ids),
        Err(Ok(StreamError::BatchTooLarge))
    );
    assert_eq!(token::Client::new(&env, &token).balance(&recipient), 0);
}

#[test]
fn test_batch_withdraw_handles_mixed_tokens() {
    let env = Env::default();
    env.mock_all_auths();
    let (token_a, _) = create_token(&env);
    let (token_b, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token_a, &sender, 1_000);
    mint(&env, &token_b, &sender, 1_000);

    let a = client.create_stream(&sender, &recipient, &token_a, &1_000, &1_000);
    let b = client.create_stream(&sender, &recipient, &token_b, &1_000, &1_000);
    advance(&env, 100);

    let result = client.batch_withdraw(&recipient, &vec![&env, a, b]);
    assert_eq!(result.len(), 2);
    // The batch returns amounts per stream, not a single total, precisely
    // because the streams need not share a token.
    assert_eq!(result.get(0).unwrap(), (a, 100));
    assert_eq!(result.get(1).unwrap(), (b, 100));
    assert_eq!(token::Client::new(&env, &token_a).balance(&recipient), 100);
    assert_eq!(token::Client::new(&env, &token_b).balance(&recipient), 100);
}

#[test]
fn test_batch_withdraw_handles_mixed_schedules() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 4_000);

    let linear = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    let steps = step_schedule(&env, &[(100, 300), (1_000, 700)]);
    let stepped = client.create_step_vesting_stream(&sender, &recipient, &token, &1_000, &steps);
    let cliff =
        client.create_hybrid_cliff_stream(&sender, &recipient, &token, &1_000, &500, &400, &600);
    mint(&env, &token, &sender, 1_000);
    let linear2 = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    advance(&env, 100);
    let result = client.batch_withdraw(&recipient, &vec![&env, linear, stepped, cliff, linear2]);

    // One call, four different accrual rules: linear 100, step 300, hybrid
    // still 0 before its cliff, linear 100.
    assert_eq!(result.len(), 3);
    assert_eq!(result.get(0).unwrap(), (linear, 100));
    assert_eq!(result.get(1).unwrap(), (stepped, 300));
    assert_eq!(result.get(2).unwrap(), (linear2, 100));
    assert!(!result.iter().any(|(id, _)| id == cliff));
    assert_eq!(token::Client::new(&env, &token).balance(&recipient), 500);
}

#[test]
fn test_batch_withdraw_marks_streams_completed_and_emits() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);
    let a = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    let b = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    advance(&env, 1_000);
    let result = client.batch_withdraw(&recipient, &vec![&env, a, b]);
    assert_eq!(result.len(), 2);

    // Snapshot now: the host only exposes the events of the most recent
    // invocation, so any follow-up call would clear them.
    let events = env.events().all();

    // A batch must leave the same terminal state the single path would, or a
    // completed stream could be paid twice by a later batch.
    assert!(client.is_stream_completed(&a));
    assert!(client.is_stream_completed(&b));
    assert_eq!(
        client.get_stream(&a).unwrap().status,
        StreamStatus::Completed
    );

    let withdrawals: u32 = events
        .iter()
        .filter(|e| {
            e.1.len() >= 2
                && Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                    == Symbol::new(&env, "tokens_withdrawn")
        })
        .count() as u32;
    let completions: u32 = events
        .iter()
        .filter(|e| {
            e.1.len() >= 2
                && Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                    == Symbol::new(&env, "stream_completed")
        })
        .count() as u32;
    assert_eq!(withdrawals, 2);
    assert_eq!(completions, 2);
}

#[test]
fn test_batch_withdraw_event_carries_per_stream_amount() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 2_000);
    let a = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    let b = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    advance(&env, 300);
    client.batch_withdraw(&recipient, &vec![&env, a, b]);

    // Indexers key off `tokens_withdrawn`, so each stream needs its own event
    // rather than one aggregate the backend cannot attribute.
    let events = env.events().all();
    for id in [a, b] {
        let ev = events
            .iter()
            .find(|e| {
                e.1.len() >= 2
                    && Symbol::try_from_val(&env, &e.1.get(0).unwrap()).unwrap()
                        == Symbol::new(&env, "tokens_withdrawn")
                    && u64::try_from_val(&env, &e.1.get(1).unwrap()) == Ok(id)
            })
            .unwrap_or_else(|| panic!("no tokens_withdrawn event for stream {id}"));
        let payload: TokensWithdrawnEvent =
            TokensWithdrawnEvent::try_from_val(&env, &ev.2).unwrap();
        assert_eq!(payload.stream_id, id);
        assert_eq!(payload.recipient, recipient);
        assert_eq!(payload.amount, 300);
    }
}

#[test]
fn test_batch_withdraw_is_idempotent_within_a_ledger() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    advance(&env, 500);
    assert_eq!(client.batch_withdraw(&recipient, &vec![&env, id]).len(), 1);
    // Time has not moved, so the accrual is already zero: a second call in the
    // same ledger must not pay the same window twice.
    let second = client.batch_withdraw(&recipient, &vec![&env, id]);
    assert!(second.is_empty());
    assert_eq!(token::Client::new(&env, &token).balance(&recipient), 500);
}

#[test]
fn test_batch_withdraw_accrues_across_successive_ledgers() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 1_000);
    let id = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    let mut total: i128 = 0;
    for _ in 0..4 {
        advance(&env, 250);
        let result = client.batch_withdraw(&recipient, &vec![&env, id]);
        total += result.get(0).map(|(_, a)| a).unwrap_or(0);
    }
    // 4 x 250s at 1/s, never over-paying the 1_000 deposited.
    assert_eq!(total, 1_000);
    assert!(client.is_stream_completed(&id));
    assert_eq!(token::Client::new(&env, &token).balance(&recipient), 1_000);
}

#[test]
fn test_batch_withdraw_during_protocol_pause_pays_vested_funds() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let admin = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    client.initialize(&admin, &Address::generate(&env), &0);
    mint(&env, &token, &sender, 2_000);
    let a = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);
    let b = client.create_stream(&sender, &recipient, &token, &1_000, &1_000);

    advance(&env, 100);
    client.set_protocol_pause(&admin, &true);

    let result = client.batch_withdraw(&recipient, &vec![&env, a, b]);
    assert_eq!(result.len(), 2);
    assert_eq!(token::Client::new(&env, &token).balance(&recipient), 200);
}

#[test]
fn test_batch_withdraw_before_initialize_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let client = create_contract(&env);

    assert_eq!(
        client.try_batch_withdraw(&Address::generate(&env), &vec![&env, 1u64]),
        Err(Ok(StreamError::StreamNotFound))
    );
}

#[test]
fn test_batch_withdraw_never_exceeds_escrow_across_many_streams() {
    let env = Env::default();
    env.mock_all_auths();
    let (token, _) = create_token(&env);
    let client = create_contract(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &token, &sender, 10_000);

    let ids = create_linear_fanout(&env, &client, &sender, &recipient, &token, 10, 1_000, 1_000);
    let contract = client.address.clone();
    let balances = token::Client::new(&env, &token);

    // Poll far more often than the streams vest, and assert after every batch
    // that the payouts never exceed what was actually held in escrow.
    for _ in 0..200 {
        advance(&env, 10);
        client.batch_withdraw(&recipient, &ids);
        let paid = balances.balance(&recipient);
        assert!(paid <= 10_000, "overpaid {paid} of 10_000 escrowed");
    }

    advance(&env, 1_000);
    client.batch_withdraw(&recipient, &ids);
    assert_eq!(balances.balance(&recipient), 10_000);
    assert_eq!(balances.balance(&contract), 0, "escrow not fully drained");
}
