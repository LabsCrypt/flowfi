# FlowFi Contracts

This directory contains the Soroban smart contracts for FlowFi.

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
