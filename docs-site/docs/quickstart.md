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

## Running in Local Sandbox Mode

The local mock sandbox lets you run the frontend and backend with seeded demo
data, without a funded Testnet wallet or live Soroban RPC. From the repository
root, install dependencies once and start the full stack:

```bash
npm install
npm run dev:mock
```

This starts PostgreSQL, Redis, and the mock Soroban RPC, prepares and seeds the
local database with `scripts/seed-mock-data.ts`, then starts the backend and
frontend. The backend is launched with `SANDBOX_MODE_ENABLED=true` by the
`dev:mock:start` script. The backend configuration uses this variable name
(rather than `SANDBOX_MODE`).

To run the seed script directly, first ensure the local database is running and
its schema has been prepared, then run this command from the repository root:

```bash
npx tsx scripts/seed-mock-data.ts
```

The script uses `DATABASE_URL` if set; otherwise, it defaults to the local
sandbox database at `******localhost:5433/flowfi`.

Once the services are running, open the app at [http://localhost:3000](http://localhost:3000).
Select **Sandbox** in the frontend network selector to use the local mock RPC
for network-dependent features. The mock RPC does not support transaction
simulation, so use the Testnet workflow above when testing real Stellar
transactions.
