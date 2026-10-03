---
title: Python SDK
---

# Python SDK (`flowfi`)

```bash
pip install flowfi
```

```python
from flowfi import FlowFiClient

client = FlowFiClient(
    rpc_url="https://soroban-testnet.stellar.org",
    contract_id="CDLZ...CONTRACT",
)

stream = client.get_stream(stream_id=1)
claimable = client.get_claimable_amount(stream_id=1)
projected_end = client.get_projected_end_time(stream_id=1)

# Withdraw (requires a funded secret key)
client.withdraw(secret_key="S...", stream_id=1)
```

Amounts are integer stroops (`int`). The client is synchronous and wraps the
same Soroban RPC entry points as the TypeScript SDK; errors raise
`FlowFiContractError` carrying the numeric `StreamError` code.
