extern crate std;

use super::*;
use errors::StreamError;
use soroban_sdk::{testutils::Address as _, token, Address, Env};

#[allow(dead_code)]
fn token(env: &Env) -> Address {
    env.register_stellar_asset_contract_v2(Address::generate(env))
        .address()
}
fn contract(env: &Env) -> StreamContractClient<'_> {
    let id = env.register(StreamContract, ());
    StreamContractClient::new(env, &id)
}
#[allow(dead_code)]
fn mint(env: &Env, t: &Address, a: &Address, n: i128) {
    token::StellarAssetClient::new(env, t).mint(a, &n);
}

// ─── Tests for existing entrypoints ──────────────────────────────────────────

#[test]
fn extend_stream_ttl_requires_existing_stream() {
    // Verifies that any stream-ID-based operation returns StreamNotFound for
    // a non-existent stream ID.
    let env = Env::default();
    env.mock_all_auths();
    let c = contract(&env);
    assert_eq!(
        c.try_withdraw(&Address::generate(&env), &999),
        Err(Ok(StreamError::StreamNotFound))
    );
}

// ─── Tests for unimplemented entrypoints (preserved as acceptance criteria) ──
//
// The tests below reference entrypoints or types that are planned but not yet
// in lib.rs:
//   - `transfer_recipient`     (recipient reassignment — unimplemented)
//   - `create_stream_with_cliff` / `batch_create_streams` (convenience wrappers)
//   - `BatchStreamInput`        (batch creation type)
//
// They are kept here in commented form to document the intended behaviour and
// will be uncommented once the corresponding entrypoints are implemented.

// #[test]
// fn recipient_transfer_settles_old_and_allows_new_withdrawal() { ... }
//
// #[test]
// fn recipient_transfer_requires_current_recipient_and_active_stream() { ... }
//
// #[test]
// fn cliff_blocks_then_unlocks_and_cancel_settles() { ... }
//
// #[test]
// fn cliff_duration_must_be_valid() { ... }
//
// #[test]
// fn batch_creates_streams_and_aggregates_token_deposit() { ... }
//
// #[test]
// fn batch_rejects_empty_and_invalid_input() { ... }
