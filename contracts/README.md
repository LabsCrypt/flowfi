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

## Building & Testing

To build the contracts for testing and validation:

```bash
cargo build
cargo test
```

## WASM Target

To compile the contract to the `wasm32-unknown-unknown` target for Soroban deployment:

```bash
cargo build --target wasm32-unknown-unknown --release
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/stream_contract.wasm
```

The optimized WASM file will be available at `target/wasm32-unknown-unknown/release/stream_contract.optimized.wasm`.
