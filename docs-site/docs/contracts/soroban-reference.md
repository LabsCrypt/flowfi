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
