---
title: Rust client
---

# Rust client

Rust integrations use the contract crate's own generated client — the same
artifact the contract's test suite uses, so it cannot drift from the ABI.

```rust
use soroban_sdk::{Address, Env};
use stream_contract::StreamContractClient;

fn main() {
    let env = Env::default();
    let contract_id = env.register(stream_contract::StreamContract, ());
    let client = StreamContractClient::new(&env, &contract_id);

    let stream_id = client.create_stream(&sender, &recipient, &token, &1_000_000_000i128, &86_400u64);
    let claimable = client.get_claimable_amount(&stream_id);
    println!("claimable: {claimable:?}");
}
```

Add the crate as a path dependency:

```toml
[dependencies]
stream_contract = { path = "../contracts/stream_contract" }
```

Or call the deployed contract via
[`StreamContractClient::new(&env, &contract_address)`](https://github.com/LabsCrypt/flowfi/blob/main/contracts/stream_contract/src/lib.rs)
after uploading the WASM.
