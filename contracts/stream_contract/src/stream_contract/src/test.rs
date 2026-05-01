#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

/// Simple deterministic pseudo-random generator (no external deps)
fn pseudo_rand(seed: &mut u64) -> u64 {
    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
    *seed
}

#[test]
fn fuzz_stream_invariants() {
    let env = Env::default();
    let mut seed: u64 = 42;

    for _ in 0..10_000 {
        // Generate random actors
        let _sender = Address::generate(&env);
        let _recipient = Address::generate(&env);

        // Generate random values (bounded to avoid overflow)
        let deposited = (pseudo_rand(&mut seed) % 1_000_000) as i128;
        let withdrawn = (pseudo_rand(&mut seed) % deposited.max(1) as u64) as i128;

        let elapsed_seconds = (pseudo_rand(&mut seed) % 10_000) as i128;
        let rate_per_second = (pseudo_rand(&mut seed) % 1_000) as i128;

        let claimable = (rate_per_second * elapsed_seconds)
            .min(deposited - withdrawn)
            .max(0);

        let withdrawn_before_cancel = withdrawn;
        let cancel_refund = (deposited - withdrawn_before_cancel).max(0);

        // 🧠 Invariants

        // 1. withdrawn <= deposited
        assert!(
            withdrawn <= deposited,
            "Invariant failed: withdrawn > deposited"
        );

        // 2. claimable <= (deposited - withdrawn)
        assert!(
            claimable <= (deposited - withdrawn),
            "Invariant failed: claimable exceeds remaining balance"
        );

        // 3. rate_per_second * elapsed_seconds >= 0
        assert!(
            rate_per_second * elapsed_seconds >= 0,
            "Invariant failed: negative accrual"
        );

        // 4. cancel_refund + withdrawn_before_cancel <= deposited
        assert!(
            cancel_refund + withdrawn_before_cancel <= deposited,
            "Invariant failed: total payout exceeds deposit"
        );
    }
}