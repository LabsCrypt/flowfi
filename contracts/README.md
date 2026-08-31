# FlowFi Contracts

This directory contains the Soroban smart contracts for FlowFi.

## Workspace Layout

This directory is a [Cargo workspace](https://doc.rust-lang.org/book/ch14-03-cargo-workspaces.html)
root. The workspace manifest is `contracts/Cargo.toml`, and each contract lives in its
own member crate under this directory.

```
contracts/
├── Cargo.toml              # Workspace manifest — run `cargo build` / `cargo test` here
├── Cargo.lock
└── stream_contract/         # Member crate (the core streaming contract)
    ├── Cargo.toml
    └── src/
```

**Always run `cargo build` / `cargo test` from the workspace root** (`contracts/`), never
from inside a member crate. The workspace `[profile.release]` section in `Cargo.toml`
configures WASM-specific optimisations for all members.

## Adding a New Contract Crate

1. Create a new crate directory under `contracts/`, e.g. `contracts/my_contract/`.
2. Add a `[package]` section in its `Cargo.toml` and reference `soroban-sdk` via
   `workspace = true`:
   ```toml
   [dependencies]
   soroban-sdk = { workspace = true }
   ```
3. Register the crate in `contracts/Cargo.toml` under `[workspace] members`:
   ```toml
   members = ["stream_contract", "my_contract"]
   ```
4. Run `cargo build` from `contracts/` to verify the workspace compiles.

For contract-specific documentation see the crate's own `README.md`.

## Crate docs

- **[`stream_contract/`](./stream_contract/)** — Core streaming contract (create, top-up,
  withdraw, cancel, pause/resume). See [`stream_contract/README.md`](./stream_contract/README.md)
  for its full API reference.

## Layout

- `stream_contract/`: Contains the core streaming logic, including stream creation, funding, claiming, and cancellation.

## Stream State Machine

Payment streams have two independent boolean fields (`is_active` and `paused`) plus a
`status` enum. The following invariants govern state transitions:

| Current Status | Allowed Transitions | Notes |
|----------------|---------------------|-------|
| `Active` | → `Paused`, → `Cancelled`, → `Completed` | `pause_stream` sets `paused=true`, `cancel_stream` sets `is_active=false` |
| `Paused` | → `Active` (resume), → `Cancelled` | `resume_stream` clears `paused`; `cancel_stream` sets `is_active=false` |
| `Cancelled` | **No transitions allowed** | **Invariant: a cancelled stream must never be resumable.** Once `status` is `Cancelled`, the stream is permanently inactive regardless of `paused` or `is_active` values. |
| `Completed` | **No transitions allowed** | Stream fully drained; `is_active=false` |

### Critical Invariant: Cancelled Streams Are Permanent

The `is_active` and `paused` fields are independently-settable, but once a stream's
`status` is set to `Cancelled` (via `cancel_stream`), it **cannot** be resumed. This
invariant must be preserved across all contract changes to prevent state-invariant bugs.

**Why this matters:** If a cancelled stream could be resumed, it would allow token
redistribution after the sender has already received their refund, creating a
double-spend vulnerability.

**Enforcement:** The `cancel_stream` function sets both `is_active = false` and
`status = Cancelled`. The `resume_stream` function requires `paused = true` but
does not explicitly re-check `status`, so the invariant relies on the fact that
`cancel_stream` sets `is_active = false` and `validate_stream_active` is called
before `pause_stream`. See Testing #94 for test coverage of this invariant.

## Building & Testing

To build the contracts for testing and validation:

```bash
cargo build
cargo test
```

## Rust Toolchain

CI runs on the **stable** Rust toolchain (via `dtolnay/rust-toolchain@stable`)
with the `wasm32-unknown-unknown` target installed and the `rustfmt` / `clippy`
components. The workspace and member crates declare `rust-version = "1.81.0"` as
the minimum supported Rust version.

## WASM Target

To compile the contract to the `wasm32-unknown-unknown` target for Soroban deployment:

```bash
cargo build --target wasm32-unknown-unknown --release
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/stream_contract.wasm
```

The optimized WASM file will be available at `target/wasm32-unknown-unknown/release/stream_contract.optimized.wasm`.
