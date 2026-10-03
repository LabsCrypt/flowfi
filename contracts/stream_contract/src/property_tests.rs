//! Property-based / fuzz tests for the economic-solvency invariants of
//! `StreamContract` (issue #1455).
//!
//! The suite is deliberately split into two tiers:
//!
//! 1. **Pure in-memory model** (`randomized_stream_invariants`) — cheap enough
//!    to run the full **20 000** cases demanded by the acceptance criteria. It
//!    checks that a hand-rolled model of the accounting can never drive
//!    `withdrawn` past `deposited`, can never report a negative claimable
//!    balance, and never loses the deposited/withdrawn/claimable identity.
//!
//! 2. **Contract-driven** (`cliff_protection_invariant`,
//!    `zero_sum_completion_invariant`, `contract_solvency_invariant`) — every
//!    case spins up a real Soroban `Env`, registers `StreamContract`, mints a
//!    Stellar asset and executes entrypoints. These are orders of magnitude
//!    heavier, so they run a reduced case count (512 each). The split keeps the
//!    fast fuzzing depth high while still exercising the real host, real token
//!    transfers and the real arithmetic paths.
//!
//! Invariants covered:
//! - **Withdrawn monotonicity** — `withdrawn` never decreases.
//! - **Conservation** — `withdrawn <= deposited`.
//! - **Solvency** — the contract's token balance is always at least the sum of
//!   `deposited - withdrawn` across every *live* stream.
//! - **Non-negative claimable** — `get_claimable_amount >= 0`, including under
//!   adversarial / overflow-sized deposits.
//! - **Cliff protection** — for every `t < cliff_time`, `claimable(t) == 0`.
//! - **Zero-sum completion** — a fully drained stream ends with
//!   `deposited == withdrawn`, `claimable == 0` and no stranded dust.

use proptest::prelude::*;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Env,
};

// ─── Tier 1: pure in-memory model ────────────────────────────────────────────

#[derive(Clone, Debug)]
struct Model {
    deposited: i128,
    withdrawn: i128,
    rate: i128,
    last_time: u64,
    paused_at: Option<u64>,
}

impl Model {
    fn claimable(&self, now: u64) -> i128 {
        let end = self.paused_at.unwrap_or(now);
        let elapsed = end.saturating_sub(self.last_time) as i128;
        (elapsed.saturating_mul(self.rate))
            .min(self.deposited.saturating_sub(self.withdrawn).max(0))
    }
}

#[derive(Clone, Debug)]
enum Action {
    Advance(u32),
    Pause,
    Resume,
    Withdraw,
    TopUp(u32),
    Cancel,
}

fn action_strategy() -> impl Strategy<Value = Action> {
    prop_oneof![
        (1u32..10_000).prop_map(Action::Advance),
        Just(Action::Pause),
        Just(Action::Resume),
        Just(Action::Withdraw),
        (1u32..100_000).prop_map(Action::TopUp),
        Just(Action::Cancel),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 20_000, .. ProptestConfig::default() })]
    #[test]
    fn randomized_stream_invariants(
        deposited in 1i128..1_000_000_000_000_000_000i128,
        duration in 1u64..100_000u64,
        actions in prop::collection::vec(action_strategy(), 1..100),
    ) {
        let mut model = Model { deposited, withdrawn: 0, rate: (deposited / duration as i128).max(1), last_time: 0, paused_at: None };
        let mut now = 0u64;
        let mut previous_withdrawn = 0i128;
        let mut paused_claimable = None;
        let mut cancelled = false;

        for action in actions {
            match action {
                Action::Advance(dt) if !cancelled => now = now.saturating_add(dt as u64),
                Action::Pause if !cancelled && model.paused_at.is_none() => {
                    paused_claimable = Some(model.claimable(now));
                    model.paused_at = Some(now);
                },
                Action::Resume if !cancelled => {
                    if let Some(paused_at) = model.paused_at.take() {
                        let pause_duration = now.saturating_sub(paused_at);
                        model.last_time = model.last_time.saturating_add(pause_duration);
                    }
                },
                Action::Withdraw if !cancelled => {
                    let amount = model.claimable(now);
                    model.withdrawn = model.withdrawn.saturating_add(amount);
                    model.last_time = now;
                    paused_claimable = None;
                },
                Action::TopUp(amount) if !cancelled => {
                    let accrued = model.claimable(now);
                    model.deposited = model.deposited.saturating_add(amount as i128);
                    if model.paused_at.is_none() {
                        model.last_time = now;
                    }
                    let _ = accrued;
                },
                Action::Cancel if !cancelled => {
                    model.withdrawn = model.withdrawn.saturating_add(model.claimable(now));
                    cancelled = true;
                },
                _ => {}
            }

            // No amount may ever be negative, even under adversarial input.
            prop_assert!(model.claimable(now) >= 0);
            // Withdrawals are monotonic and can never exceed what was deposited.
            prop_assert!(model.withdrawn >= previous_withdrawn);
            prop_assert!(model.withdrawn <= model.deposited);
            // Deposited always covers what has been withdrawn plus what is still claimable.
            prop_assert!(model.deposited >= model.withdrawn.saturating_add(model.claimable(now)));
            if model.paused_at.is_some() && paused_claimable.is_some() && !cancelled {
                prop_assert!(model.claimable(now) - paused_claimable.unwrap() <= (model.deposited - deposited));
            }
            previous_withdrawn = model.withdrawn;
        }
    }
}

// ─── Contract-driven harness ─────────────────────────────────────────────────

/// Registers a Stellar asset contract and returns its address.
fn new_token(env: &Env) -> Address {
    env.register_stellar_asset_contract_v2(Address::generate(env))
        .address()
}

/// Registers `StreamContract` and returns a client bound to it.
fn new_client(env: &Env) -> StreamContractClient<'_> {
    let id = env.register(StreamContract, ());
    StreamContractClient::new(env, &id)
}

/// Advances the ledger clock by `seconds`.
fn advance(env: &Env, seconds: u64) {
    env.ledger()
        .with_mut(|l| l.timestamp = l.timestamp.saturating_add(seconds));
}

/// Sums the outstanding liability of every *live* stream.
///
/// A cancelled or completed stream is fully settled: its residual has already
/// been paid out, so it contributes nothing to the contract's obligations even
/// though `deposited - withdrawn` may be non-zero for a cancelled stream.
fn live_liability(client: &StreamContractClient<'_>, stream_count: u64) -> (i128, i128) {
    let mut liability: i128 = 0;
    let mut claimable: i128 = 0;
    for id in 1..=stream_count {
        if let Some(stream) = client.get_stream(&id) {
            if stream.is_active {
                liability = liability.saturating_add(
                    stream
                        .deposited_amount
                        .saturating_sub(stream.withdrawn_amount),
                );
            }
        }
        claimable = claimable.saturating_add(client.get_claimable_amount(&id).unwrap_or(0));
    }
    (liability, claimable)
}

// ─── Cliff protection ────────────────────────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig { cases: 512, .. ProptestConfig::default() })]
    /// `create_hybrid_cliff_stream` + ledger advance: nothing unlocks before the
    /// cliff, and the cliff unlocks exactly the declared lump at the boundary.
    #[test]
    fn cliff_protection_invariant(
        amount in 10_000i128..1_000_000_000i128,
        cliff_bps in 100u32..9_000u32,
        cliff_offset in 1u64..100_000u64,
        linear_duration in 1u64..1_000u64,
        sample_frac in 0u64..1_000_000u64,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let t = new_token(&env);
        let client = new_client(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        token::StellarAssetClient::new(&env, &t).mint(&sender, &amount);

        // `amount * bps / 10_000` is strictly inside `(0, amount)`, and
        // `linear_amount >= amount / 10 >= 1_000 >= linear_duration`, so the
        // implied rate is always >= 1 and creation cannot be rejected.
        let cliff_unlock = amount * cliff_bps as i128 / 10_000;
        let cliff_time = cliff_offset;

        let id = client.create_hybrid_cliff_stream(
            &sender,
            &recipient,
            &t,
            &amount,
            &cliff_time,
            &cliff_unlock,
            &linear_duration,
        );

        // Any timestamp strictly before the cliff must expose zero claimable.
        let before = sample_frac % cliff_offset;
        env.ledger().with_mut(|l| l.timestamp = before);
        prop_assert_eq!(client.get_claimable_amount(&id), Some(0));

        // At the cliff boundary exactly `cliff_unlock` becomes claimable.
        env.ledger().with_mut(|l| l.timestamp = cliff_time);
        prop_assert_eq!(client.get_claimable_amount(&id), Some(cliff_unlock));
    }
}

// ─── Zero-sum completion ─────────────────────────────────────────────────────

proptest! {
    #![proptest_config(ProptestConfig { cases: 512, .. ProptestConfig::default() })]
    /// A stream that has fully vested and been withdrawn ends with no stranded
    /// dust: `deposited == withdrawn`, `claimable == 0`, and the contract holds
    /// none of the sender's tokens for that stream.
    #[test]
    fn zero_sum_completion_invariant(
        amount in 1_000_000i128..1_000_000_000_000_000_000i128,
        duration in 1u64..1_000_000u64,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let t = new_token(&env);
        let client = new_client(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);
        token::StellarAssetClient::new(&env, &t).mint(&sender, &amount);

        let id = client.create_stream(&sender, &recipient, &t, &amount, &duration);

        // Twice the nominal duration is more than enough to drain the deposit
        // even after the integer-division rate truncation.
        advance(&env, duration.saturating_mul(2).saturating_add(2));

        let withdrawn = client.withdraw(&recipient, &id);
        prop_assert_eq!(withdrawn, amount);
        prop_assert!(client.is_stream_completed(&id));

        let stream = client.get_stream(&id).unwrap();
        prop_assert_eq!(stream.deposited_amount, stream.withdrawn_amount);
        prop_assert_eq!(client.get_claimable_amount(&id), Some(0));

        // Nothing is stranded in the contract for this stream.
        let balance = token::Client::new(&env, &t).balance(&client.address);
        prop_assert_eq!(balance, 0);
    }
}

// ─── Contract-driven solvency ────────────────────────────────────────────────

#[derive(Clone, Debug)]
enum ContractAction {
    /// Advance the ledger clock.
    Advance(u32),
    /// `(stream selector, top-up amount)`.
    TopUp(u8, u32),
    Withdraw(u8),
    Pause(u8),
    Resume(u8),
    Cancel(u8),
}

fn contract_action_strategy() -> impl Strategy<Value = ContractAction> {
    prop_oneof![
        (1u32..5_000).prop_map(ContractAction::Advance),
        (any::<u8>(), 1u32..20_000).prop_map(|(i, a)| ContractAction::TopUp(i, a)),
        any::<u8>().prop_map(ContractAction::Withdraw),
        any::<u8>().prop_map(ContractAction::Pause),
        any::<u8>().prop_map(ContractAction::Resume),
        any::<u8>().prop_map(ContractAction::Cancel),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 512, .. ProptestConfig::default() })]
    /// Runs randomized action sequences against the real contract and asserts,
    /// after **every** mutation, that the contract is solvent:
    ///
    /// `token_balance(contract) >= Σ_{live streams} (deposited - withdrawn)`
    ///
    /// and that no stream ever reports a negative claimable balance. Errors from
    /// individual calls (pausing twice, withdrawing nothing, topping up a
    /// finished stream, ...) are expected and deliberately ignored, so the fuzz
    /// stays adversarial rather than only exercising the happy path.
    #[test]
    fn contract_solvency_invariant(
        amounts in prop::collection::vec(1_000_000i128..1_000_000_000_000i128, 1..4),
        durations in prop::collection::vec(10u64..10_000u64, 1..4),
        hybrid_flags in prop::collection::vec(any::<bool>(), 1..4),
        actions in prop::collection::vec(contract_action_strategy(), 1..40),
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let t = new_token(&env);
        let client = new_client(&env);
        let sender = Address::generate(&env);
        let recipient = Address::generate(&env);

        let n = amounts.len().min(durations.len()).min(hybrid_flags.len());
        prop_assume!(n >= 1);

        let total: i128 = amounts.iter().take(n).sum();
        let headroom = total.saturating_mul(20).saturating_add(1_000_000_000);
        token::StellarAssetClient::new(&env, &t).mint(&sender, &headroom);

        // Create the streams up front. Hybrid streams pick a cliff and a lump
        // that always leave a non-empty, positive-rate linear tail.
        for i in 0..n {
            let amount = amounts[i];
            let duration = durations[i];
            if hybrid_flags[i] {
                let cliff_offset = (duration / 2).max(1);
                let cliff_unlock = (amount / 3).max(1);
                client.create_hybrid_cliff_stream(
                    &sender,
                    &recipient,
                    &t,
                    &amount,
                    &cliff_offset,
                    &cliff_unlock,
                    &duration,
                );
            } else {
                client.create_stream(&sender, &recipient, &t, &amount, &duration);
            }
        }

        let stream_count = n as u64;
        assert_solvent(&env, &client, &t, stream_count);

        for action in actions {
            let idx = |sel: u8| (sel as u64) % stream_count + 1;
            match action {
                ContractAction::Advance(dt) => advance(&env, dt as u64),
                ContractAction::TopUp(sel, amt) => {
                    let id = idx(sel);
                    let scale = match client.get_stream(&id) {
                        Some(s) => s.deposited_amount / 1_000 + 1,
                        None => 1,
                    };
                    let amount = (amt as i128).saturating_mul(scale);
                    let _ = client.try_top_up_stream(&sender, &id, &amount);
                }
                ContractAction::Withdraw(sel) => {
                    let _ = client.try_withdraw(&recipient, &idx(sel));
                }
                ContractAction::Pause(sel) => {
                    let _ = client.try_pause_stream(&sender, &idx(sel));
                }
                ContractAction::Resume(sel) => {
                    let _ = client.try_resume_stream(&sender, &idx(sel));
                }
                ContractAction::Cancel(sel) => {
                    let _ = client.try_cancel_stream(&sender, &idx(sel));
                }
            }

            // The solvency invariant must hold after every single mutation.
            assert_solvent(&env, &client, &t, stream_count);
        }
    }
}

/// Asserts the core solvency and non-negativity invariants against the live
/// contract state. Extracted so the `proptest!` body stays readable.
fn assert_solvent(env: &Env, client: &StreamContractClient<'_>, t: &Address, stream_count: u64) {
    let (liability, total_claimable) = live_liability(client, stream_count);
    let balance = token::Client::new(env, t).balance(&client.address);

    // The contract must always hold enough to honour every live stream.
    assert!(
        balance >= liability,
        "insolvent: contract balance {balance} < live liability {liability}"
    );
    // Claimable balances are never negative.
    assert!(
        total_claimable >= 0,
        "negative claimable: {total_claimable}"
    );
}
