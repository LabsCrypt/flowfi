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

Use this workflow to start FlowFi's local services and load seeded mock data. Run the commands below from the repository root; see the network note below before using network-dependent UI.

### Prerequisites

Install Node.js 20+ with npm and Docker with Docker Compose. Install the repository dependencies once if you have not already:

```bash
npm install
```

### Start the Local Sandbox

The recommended command starts the local infrastructure, prepares and seeds the database, then starts the backend and frontend:

```bash
npm run dev:mock
```

The command runs these stages in order:

1. `dev:mock:infra` starts PostgreSQL, Redis, and a mock Soroban RPC service in Docker containers. PostgreSQL is published on port `5433`, Redis on `6379`, and the mock RPC on `8000`.
2. `dev:mock:seed` generates the Prisma client, pushes the schema to the local database, and runs `scripts/seed-mock-data.ts` to add demo data.
3. `dev:mock:start` runs the backend and frontend development servers as local Node.js processes. It sets `SANDBOX_MODE_ENABLED=true` for the backend and points it at the local database, Redis, and mock RPC.

> **Database safety:** the schema push uses `prisma db push --accept-data-loss`. Use this workflow only with a disposable local development database; do not point it at data you need to keep.

If you need to run each stage separately from the repository root, use:

```bash
npm run dev:mock:infra
npm run dev:mock:seed
npm run dev:mock:start
```

The seed stage runs `scripts/seed-mock-data.ts`. To invoke that script directly after the local database schema is prepared, run:

```bash
npx tsx scripts/seed-mock-data.ts
```

The seed script uses `DATABASE_URL` when set, or defaults to `postgresql://flowfi:flowfi_dev_password@localhost:5433/flowfi`.

### Access the Application

After the backend and frontend have finished starting, open:

* Frontend: [http://localhost:3000](http://localhost:3000)
* Backend API: [http://localhost:3001/v1](http://localhost:3001/v1)
* Interactive API documentation: [http://localhost:3001/api-docs](http://localhost:3001/api-docs)

Stop the backend and frontend with `Ctrl+C`. Stop the infrastructure containers from the repository root with:

```bash
docker compose down
```

This keeps the PostgreSQL volume. Avoid `docker compose down -v` if you need to preserve its contents.

### Local Sandbox vs. Stellar Testnet

Local Sandbox provides local PostgreSQL and Redis, seeded demo records, and a mock Soroban RPC endpoint. The frontend's network selector is separate from the backend startup settings and defaults to Testnet in a new browser session. Choose **Sandbox** in the selector before using network-dependent UI so those features use the local RPC.

The mock RPC does not support transaction simulation, so contract write flows are not available in Local Sandbox. The local workflow is useful for exploring the app with seeded data and developing against its local services; use the Testnet workflow below when you need to test actual Stellar transactions.

The Testnet quickstart above connects to Stellar Testnet and is for testing actual network interactions. Use a funded Testnet account only when you intentionally switch to that workflow.

The issue proposes `SANDBOX_MODE=true`, but the current backend reads `SANDBOX_MODE_ENABLED`; the `dev:mock` command sets the supported variable for you.

### Troubleshooting

#### PostgreSQL does not start

From the repository root, check the service status and logs:

```bash
docker compose ps
docker compose logs postgres
```

#### A port is already in use

The workflow needs ports `3000` (frontend), `3001` (backend), `5433` (PostgreSQL), `6379` (Redis), and `8000` (mock Soroban RPC). Stop the process or container already using the required port, then retry.

#### The application fails to start

Check the `npm run dev:mock` output for the failing stage. For infrastructure containers, inspect their status and logs with `docker compose ps` and `docker compose logs <service>` from the repository root, replacing `<service>` with `postgres`, `redis`, or `mock-soroban-rpc`.

#### Database setup fails

Confirm PostgreSQL is ready and review the Prisma error output. The sandbox database URL is `postgresql://flowfi:flowfi_dev_password@localhost:5433/flowfi`; the seed script also reads `DATABASE_URL` from the environment. Because setup can accept data loss, use only a disposable local database.
