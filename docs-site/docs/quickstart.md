---
title: Quickstart in 5 minutes
---

# Quickstart in 5 minutes

Create a stream and withdraw from it. Every sample targets **Stellar
Testnet**.

## 1. Get testnet XLM

```bash
curl -s "https://friendbot.stellar.org?addr=GABC...YOUR_ADDRESS"
```

## 2. Create a stream (TypeScript)

```ts
import { FlowFiClient } from "@flowfi/sdk";

const client = new FlowFiClient({
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: process.env.FLOWFI_CONTRACT_ID!,
});

const streamId = await client.createStream({
  sender: senderKeypair,
  recipient: "GBRB...RECIPIENT",
  token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  amountStroops: 1_000_000_000n,
  durationSeconds: 86_400, // drips for one day
});

console.log("stream", streamId);
```

## 3. Check the claimable amount (Python)

```python
from flowfi import FlowFiClient

client = FlowFiClient(rpc_url="https://soroban-testnet.stellar.org",
                      contract_id="CDLZ...CONTRACT")

claimable = client.get_claimable_amount(stream_id=1)
print(f"{claimable} stroops claimable right now")
```

## 4. Withdraw (cURL against the backend API)

```bash
curl -X POST "https://api.flowfi.xyz/api/v1/streams/1/withdraw" \
  -H "Authorization: Bearer $FLOWFI_JWT" \
  -H "Content-Type: application/json" \
  -d '{"recipient": "GBRB...RECIPIENT"}'
```

## 5. Watch it stream (SSE)

```ts
const events = new EventSource("https://api.flowfi.xyz/api/v1/events/stream");
events.onmessage = (e) => console.log(JSON.parse(e.data));
```

Next: [Core concepts](/core-concepts) or the [interactive
playground](/api-reference/playground).
