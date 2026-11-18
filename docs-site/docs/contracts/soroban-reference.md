---
title: Rust Soroban reference
---

# Rust Soroban reference

The contract crate (`contracts/stream_contract/`) is a standard Soroban
contract. Quick reference for contributors.

## Module map

| Module | Responsibility |
|---|---|
| `lib.rs` | Entrypoints (`#[contractimpl]`) and business rules |
| `storage.rs` | Read/write/bump helpers around `DataKey` |
| `types.rs` | `Stream`, `VestingSchedule`, `UnlockCondition` (#1482), `DataKey` |
| `errors.rs` | `StreamError` — append-only discriminants |
| `events.rs` | Typed event payloads (decoded field-name-order-independent) |
| `test.rs`, `acceptance_tests.rs`, `property_tests.rs` | Test suites |

## Build & test

```bash
cd contracts
cargo test -p stream_contract          # unit + acceptance + property
cargo build --release --target wasm32-unknown-unknown
cargo clippy --all-targets -- -D warnings
cargo fmt --all --check
```

## ABI rules

- **`StreamError` discriminants are append-only** — reordering breaks every
  client that matches on the numeric code.
- **`#[contracttype]` enums encode by variant name** — renaming a variant (or
  struct field) orphans persisted state; `migrate` exists for layout changes.
- **Events are Maps, not positional tuples** — `soroban-event-worker.ts`
  decodes by field name, so adding a field is backward compatible but
  renaming/retyping one must update the backend decoder in the same release.


## ContractError Reference

When a stream contract call fails, it returns an error code in the format `Error(Contract, #N)`. Use this table to diagnose and resolve issues:

| Code | Error Variant | When Triggered | How to Fix |
|------|--------------|----------------|------------|
| 1 | `InvalidAmount` | Amount is zero, negative, or out of range | Provide a positive, non-zero amount within token limits |
| 2 | `StreamNotFound` | No stream exists for the supplied ID | Verify the stream ID exists using `get_stream()` |
| 3 | `Unauthorized` | Caller lacks permission for this action | Ensure the caller is the stream sender or recipient |
| 4 | `StreamInactive` | Operation requires an active stream | Check stream is not cancelled or completed |
| 5 | `AlreadyInitialized` | `initialize()` called more than once | Protocol is already initialized, no action needed |
| 6 | `NotAdmin` | Caller is not the protocol admin | Use the admin account for this operation |
| 7 | `InvalidFeeRate` | Fee rate exceeds 1,000 bps (10%) | Reduce fee to ≤1,000 basis points |
| 8 | `NotInitialized` | Protocol config not initialized | Call `initialize()` first |
| 9 | `InvalidDuration` | Duration is zero | Provide a positive duration in seconds |
| 10 | `InvalidTokenAddress` | Token address is not a valid token contract | Verify the token contract address |
| 11 | `InvalidRate` | `amount / duration` rounds to zero | Increase amount or decrease duration |
| 12 | `StreamPaused` | Operation requires active (non-paused) stream | Resume the stream first using `resume_stream()` |
| 13 | `StreamNotPaused` | `resume_stream()` called on active stream | Stream is not paused, no action needed |
| 14 | `StreamAlreadyPaused` | `pause_stream()` called on paused stream | Stream is already paused |
| 15 | `ProtocolPaused` | Circuit breaker is engaged | Wait for admin to unpause the protocol |
| 16 | `EmptyVestingSchedule` | Step-tranche schedule has no steps | Provide at least one vesting step |
| 17 | `TooManyVestingSteps` | Schedule exceeds `MAX_VESTING_STEPS` | Reduce number of steps |
| 18 | `NonMonotonicVestingSteps` | Step unlock times are not increasing | Ensure each step unlocks after the previous |
| 19 | `InvalidVestingStepAmount` | Step amount is zero or negative | All steps must have positive amounts |
| 20 | `VestingStepTotalMismatch` | Step amounts don't sum to deposit | Adjust steps to match deposited amount |
| 21 | `VestingStepBeforeStart` | Step unlocks before stream start | Schedule all steps after start time |
| 22 | `InvalidCliffParameters` | Cliff configuration is invalid | Ensure cliff is after start and leaves room for linear tail |
| 23 | `BatchTooLarge` | Too many stream IDs in `batch_withdraw()` | Reduce batch size to ≤`MAX_BATCH_WITHDRAW` |
| 24 | `NotGuardian` | Caller is not admin or guardian | Use admin or emergency guardian account |
| 25 | `UnsupportedMigration` | Migration to unsupported version | Check compatible migration versions |
| 26 | `StateVersionTooNew` | On-chain state is newer than contract | Deploy newer contract version |
| 27 | `TopUpUnsupported` | Top-up called on step-tranche stream | Top-ups only work on linear/cliff streams |
| 28 | `RateModificationUnsupported` | Rate change on unsupported schedule type | Rate modifications only for linear streams |
| 29 | `InvalidNewRate` | New rate is zero or too small | Provide a valid positive rate |
| 30 | `DisputeNotSupported` | Dispute on non-disputable stream | Stream was not created with dispute support |
| 31 | `NoActiveDispute` | No active dispute to resolve | Create a dispute first |
| 32 | `NotArbiter` | Caller is not the dispute arbiter | Use the designated arbiter account |
| 33 | `AllowanceLocked` | Allowance-based operation failed | Check token allowances are sufficient |
| 34 | `ArithmeticOverflow` | Calculation exceeded i128/u64 range | Reduce amount or duration to avoid overflow |
| 35 | `StreamNotActive` | `resume_stream()` on inactive stream | Can only resume active streams |
| 36 | `StreamStillActive` | `close_stream()` with funds remaining | Withdraw all funds or cancel stream first |
| 37 | `InvalidMilestone` | Milestone ID invalid or duplicated | Check milestone IDs are unique and exist |
| 38 | `OraclePriceUnavailable` | Oracle returned no price | Wait for oracle to provide price data |
| 39 | `OraclePriceStale` | Oracle price is too old | Wait for fresh oracle price update |
| 40 | `ConditionNotMet` | Milestone condition not satisfied | Meet the milestone condition first |
| 41 | `MilestoneAlreadyUnlocked` | Milestone was already unlocked | Cannot unlock same milestone twice |
| 42 | `InvalidAttestation` | Attestation reused or wrong signer | Use fresh attestation from correct oracle |
| 43 | `MilestoneCallerUnauthorized` | Only sender/recipient can unlock | Use authorized account to trigger verification |
| 44 | `TooManyMilestones` | Exceeds `MAX_CONDITIONAL_MILESTONES` | Reduce number of milestones |
| 45 | `FeeExceedsMaximum` | Protocol fee >100 bps (1%) | Reduce fee to ≤100 basis points |
| 46 | `InvalidFeeSplit` | Fee split shares don't sum to 10,000 bps | Adjust shares to total exactly 10,000 |
| 47 | `DeadlineExpired` | Cross-asset withdrawal deadline passed | Retry with later deadline |
| 48 | `InsufficientOutput` | DEX swap returned less than minimum | Increase slippage tolerance or retry |

:::tip Quick Debugging
Most authorization errors (#3, #6, #24, #32, #43) mean you're calling from the wrong account. Verify the caller matches the expected role (admin, sender, recipient, arbiter).
:::

:::note
For detailed error handling examples, see the [SDK Integration Guide](../sdk/overview.md) and [Testing Patterns](../development/testing.md).
:::
