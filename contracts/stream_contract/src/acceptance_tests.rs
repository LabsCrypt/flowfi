//! Acceptance coverage for the position-receipt, dynamic-fee, and cross-asset
//! swap features.
//!
//! These tests intentionally exercise the contract through its public client
//! (the same surface an integrator sees), so they pin the externally observable
//! behavior rather than internal helpers.

extern crate std;

use super::*;
use crate::errors::StreamError;
use crate::types::{FeeRecipient, PositionRole, PositionStatus};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    token, Address, Env, Symbol, Vec,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Registers a Stellar asset contract and returns its address.
fn token(env: &Env) -> Address {
    env.register_stellar_asset_contract_v2(Address::generate(env))
        .address()
}

/// Registers `StreamContract` and returns its client.
fn contract(env: &Env) -> StreamContractClient<'_> {
    let id = env.register(StreamContract, ());
    StreamContractClient::new(env, &id)
}

/// Mints `amount` of `token` to `to`.
fn mint(env: &Env, token_address: &Address, to: &Address, amount: i128) {
    token::StellarAssetClient::new(env, token_address).mint(to, &amount);
}

/// Advances the ledger clock by `seconds`.
fn advance(env: &Env, seconds: u64) {
    env.ledger().with_mut(|l| l.timestamp += seconds);
}

// ─── Mock DEX router ──────────────────────────────────────────────────────────

/// Minimal 1:1 router implementing the `DexRouter` interface.
///
/// The target asset it pays out is configured by the test through instance
/// storage, so the mock can deliver real tokens to the recipient.
#[contract]
pub struct MockDex;

#[contractimpl]
impl MockDex {
    pub fn swap_exact_tokens_for_tokens(
        env: Env,
        amount_in: i128,
        amount_out_min: i128,
        _path: Vec<Address>,
        to: Address,
        _deadline: u64,
    ) -> Vec<i128> {
        // 1:1 conversion; report a zero output when the caller's slippage
        // guard cannot be met so the contract's SwapFailed path is exercised.
        let output = if amount_in >= amount_out_min {
            amount_in
        } else {
            0
        };

        let target: Address = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "target"))
            .unwrap();
        if output > 0 {
            token::Client::new(&env, &target).transfer(
                &env.current_contract_address(),
                &to,
                &output,
            );
        }

        let mut amounts = Vec::new(&env);
        amounts.push_back(amount_in);
        amounts.push_back(output);
        amounts
    }
}

/// Configures the `<MockDex as DexRouter>::target` asset.
fn set_dex_target(env: &Env, dex: &Address, target: &Address) {
    env.as_contract(dex, || {
        env.storage()
            .instance()
            .set(&Symbol::new(env, "target"), target);
    });
}

// ─── Issue #1464: Position receipts ───────────────────────────────────────────

#[test]
fn position_metadata_is_minted_on_stream_creation() {
    let env = Env::default();
    env.mock_all_auths();
    let t = token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &t, &sender, 1_000);
    let c = contract(&env);

    let id = c.create_stream(&sender, &recipient, &t, &1_000, &100);

    let sender_position = c.get_position_metadata(&id, &PositionRole::Sender);
    assert_eq!(sender_position.stream_id, id);
    assert_eq!(sender_position.owner, sender);
    assert_eq!(sender_position.token_address, t);
    assert_eq!(sender_position.rate_per_second, 10);
    assert_eq!(sender_position.start_time, 0);
    assert_eq!(sender_position.end_time, 100);
    assert!(!sender_position.is_transferable);
    assert_eq!(sender_position.status, PositionStatus::Active);

    let recipient_position = c.get_position_metadata(&id, &PositionRole::Recipient);
    assert_eq!(recipient_position.owner, recipient);

    assert_eq!(c.get_positions_by_owner(&recipient).len(), 1);
    assert_eq!(c.get_positions_by_owner(&sender).len(), 1);
}

#[test]
fn unknown_position_reports_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let c = contract(&env);

    assert_eq!(
        c.try_get_position_metadata(&999, &PositionRole::Recipient),
        Err(Ok(StreamError::PositionNotFound))
    );
}

#[test]
fn soulbound_position_cannot_be_transferred() {
    let env = Env::default();
    env.mock_all_auths();
    let t = token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &t, &sender, 1_000);
    let c = contract(&env);
    let id = c.create_stream(&sender, &recipient, &t, &1_000, &100);

    let third_party = Address::generate(&env);
    assert_eq!(
        c.try_transfer_position(&recipient, &id, &PositionRole::Recipient, &third_party),
        Err(Ok(StreamError::PositionNotTransferable))
    );
}

#[test]
fn transferable_recipient_position_updates_stream_recipient() {
    let env = Env::default();
    env.mock_all_auths();
    let t = token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &t, &sender, 1_000);
    let c = contract(&env);
    let id = c.create_stream(&sender, &recipient, &t, &1_000, &100);

    c.set_position_transferable(&recipient, &id, &PositionRole::Recipient, &true);

    let third_party = Address::generate(&env);
    c.transfer_position(&recipient, &id, &PositionRole::Recipient, &third_party);

    assert_eq!(c.get_stream(&id).unwrap().recipient, third_party);
    assert_eq!(
        c.get_position_metadata(&id, &PositionRole::Recipient).owner,
        third_party
    );
    // The index moved with the receipt.
    assert_eq!(c.get_positions_by_owner(&recipient).len(), 0);
    assert_eq!(c.get_positions_by_owner(&third_party).len(), 1);
}

#[test]
fn positions_settle_after_full_withdrawal() {
    let env = Env::default();
    env.mock_all_auths();
    let t = token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &t, &sender, 1_000);
    let c = contract(&env);
    let id = c.create_stream(&sender, &recipient, &t, &1_000, &100);

    advance(&env, 100);
    assert_eq!(c.withdraw(&recipient, &id), 1_000);

    assert_eq!(
        c.get_position_status(&id, &PositionRole::Recipient),
        Some(PositionStatus::Settled)
    );
    assert_eq!(
        c.get_position_status(&id, &PositionRole::Sender),
        Some(PositionStatus::Settled)
    );
}

#[test]
fn positions_settle_on_cancellation() {
    let env = Env::default();
    env.mock_all_auths();
    let t = token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &t, &sender, 1_000);
    let c = contract(&env);
    let id = c.create_stream(&sender, &recipient, &t, &1_000, &100);

    c.cancel_stream(&sender, &id);

    assert_eq!(
        c.get_position_status(&id, &PositionRole::Recipient),
        Some(PositionStatus::Settled)
    );
}

#[test]
fn settled_position_can_be_burned() {
    let env = Env::default();
    env.mock_all_auths();
    let t = token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &t, &sender, 1_000);
    let c = contract(&env);
    let id = c.create_stream(&sender, &recipient, &t, &1_000, &100);

    // Burning an active receipt is rejected.
    assert_eq!(
        c.try_burn_position(&recipient, &id, &PositionRole::Recipient),
        Err(Ok(StreamError::StreamStillActive))
    );

    advance(&env, 100);
    c.withdraw(&recipient, &id);
    c.burn_position(&recipient, &id, &PositionRole::Recipient);

    assert_eq!(
        c.try_get_position_metadata(&id, &PositionRole::Recipient),
        Err(Ok(StreamError::PositionNotFound))
    );
    assert_eq!(c.get_positions_by_owner(&recipient).len(), 0);
}

// ─── Issue #1465: Dynamic protocol fee splits ─────────────────────────────────

fn two_way_splits(env: &Env, dao: &Address, insurance: &Address) -> Vec<FeeRecipient> {
    let mut splits = Vec::new(env);
    splits.push_back(FeeRecipient {
        recipient: dao.clone(),
        share_bps: 7_000,
    });
    splits.push_back(FeeRecipient {
        recipient: insurance.clone(),
        share_bps: 3_000,
    });
    splits
}

#[test]
fn protocol_fee_is_split_across_recipients_without_dust() {
    let env = Env::default();
    env.mock_all_auths();
    let t = token(&env);
    let admin = Address::generate(&env);
    let legacy_treasury = Address::generate(&env);
    let dao = Address::generate(&env);
    let insurance = Address::generate(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &t, &sender, 10_000);
    let c = contract(&env);

    c.initialize(&admin, &legacy_treasury, &0);
    c.configure_protocol_fees(&admin, &100, &two_way_splits(&env, &dao, &insurance), &true);

    let id = c.create_stream(&sender, &recipient, &t, &10_000, &100);

    // 1% of 10 000 = 100; 70% to the DAO, 30% to insurance.
    let token_client = token::Client::new(&env, &t);
    assert_eq!(token_client.balance(&dao), 70);
    assert_eq!(token_client.balance(&insurance), 30);
    assert_eq!(token_client.balance(&legacy_treasury), 0);

    // Net deposited is gross minus the total fee, and the stream holds it.
    assert_eq!(c.get_stream(&id).unwrap().deposited_amount, 9_900);
}

#[test]
fn fee_above_maximum_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let dao = Address::generate(&env);
    let insurance = Address::generate(&env);
    let c = contract(&env);
    c.initialize(&admin, &treasury, &0);

    assert_eq!(
        c.try_configure_protocol_fees(&admin, &101, &two_way_splits(&env, &dao, &insurance), &true),
        Err(Ok(StreamError::FeeExceedsMaximum))
    );
}

#[test]
fn invalid_fee_split_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let dao = Address::generate(&env);
    let insurance = Address::generate(&env);
    let c = contract(&env);
    c.initialize(&admin, &treasury, &0);

    let mut bad_splits = Vec::new(&env);
    bad_splits.push_back(FeeRecipient {
        recipient: dao,
        share_bps: 5_000,
    });
    bad_splits.push_back(FeeRecipient {
        recipient: insurance,
        share_bps: 4_999,
    });

    assert_eq!(
        c.try_configure_protocol_fees(&admin, &100, &bad_splits, &true),
        Err(Ok(StreamError::InvalidFeeSplit))
    );
}

#[test]
fn non_admin_cannot_configure_fees() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let attacker = Address::generate(&env);
    let dao = Address::generate(&env);
    let insurance = Address::generate(&env);
    let c = contract(&env);
    c.initialize(&admin, &treasury, &0);

    assert_eq!(
        c.try_configure_protocol_fees(
            &attacker,
            &100,
            &two_way_splits(&env, &dao, &insurance),
            &true
        ),
        Err(Ok(StreamError::Unauthorized))
    );
}

// ─── Issue #1466: Cross-asset withdrawal ──────────────────────────────────────

#[test]
fn withdraw_and_swap_delivers_target_token() {
    let env = Env::default();
    env.mock_all_auths();
    let deposit_token = token(&env);
    let target_token = token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &deposit_token, &sender, 1_000);

    let c = contract(&env);
    let dex = env.register(MockDex, ());
    set_dex_target(&env, &dex, &target_token);
    mint(&env, &target_token, &dex, 1_000);

    let id = c.create_stream(&sender, &recipient, &deposit_token, &1_000, &100);
    advance(&env, 100);

    let deadline = env.ledger().timestamp();
    let received = c.withdraw_and_swap(&recipient, &id, &target_token, &1_000, &dex, &deadline);

    assert_eq!(received, 1_000);
    assert_eq!(
        token::Client::new(&env, &target_token).balance(&recipient),
        1_000
    );
    // Accounting stays in the deposit token and the stream is fully drained.
    let stream = c.get_stream(&id).unwrap();
    assert_eq!(stream.withdrawn_amount, 1_000);
    assert!(!stream.is_active);
}

#[test]
fn withdraw_and_swap_rejects_expired_deadline() {
    let env = Env::default();
    env.mock_all_auths();
    let deposit_token = token(&env);
    let target_token = token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &deposit_token, &sender, 1_000);

    let c = contract(&env);
    let dex = env.register(MockDex, ());
    set_dex_target(&env, &dex, &target_token);
    mint(&env, &target_token, &dex, 1_000);

    let id = c.create_stream(&sender, &recipient, &deposit_token, &1_000, &100);
    advance(&env, 100);

    let expired_deadline = env.ledger().timestamp() - 1;
    assert_eq!(
        c.try_withdraw_and_swap(
            &recipient,
            &id,
            &target_token,
            &1_000,
            &dex,
            &expired_deadline
        ),
        Err(Ok(StreamError::DeadlineExpired))
    );
}

#[test]
fn withdraw_and_swap_reverts_when_slippage_exceeded() {
    let env = Env::default();
    env.mock_all_auths();
    let deposit_token = token(&env);
    let target_token = token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &deposit_token, &sender, 1_000);

    let c = contract(&env);
    // The mock pays out 1:1, so demanding more than the principal fails.
    let min_target = 2_000;
    let dex = env.register(MockDex, ());
    set_dex_target(&env, &dex, &target_token);
    mint(&env, &target_token, &dex, 5_000);

    let id = c.create_stream(&sender, &recipient, &deposit_token, &1_000, &100);
    advance(&env, 100);

    let deadline = env.ledger().timestamp();
    assert_eq!(
        c.try_withdraw_and_swap(&recipient, &id, &target_token, &min_target, &dex, &deadline),
        Err(Ok(StreamError::SwapFailed))
    );
}

#[test]
fn withdraw_and_swap_requires_recipient() {
    let env = Env::default();
    env.mock_all_auths();
    let deposit_token = token(&env);
    let target_token = token(&env);
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);
    mint(&env, &deposit_token, &sender, 1_000);

    let c = contract(&env);
    let dex = env.register(MockDex, ());
    set_dex_target(&env, &dex, &target_token);
    mint(&env, &target_token, &dex, 1_000);

    let id = c.create_stream(&sender, &recipient, &deposit_token, &1_000, &100);
    advance(&env, 100);

    let intruder = Address::generate(&env);
    let deadline = env.ledger().timestamp();
    assert_eq!(
        c.try_withdraw_and_swap(&intruder, &id, &target_token, &1_000, &dex, &deadline),
        Err(Ok(StreamError::Unauthorized))
    );
}
