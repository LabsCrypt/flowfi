# Stellar Testnet E2E suite

Live end-to-end checks against the public Stellar Testnet. Unlike the mocked
suites under `tests/`, these hit the real network to catch drift early:

| Suite | Detects |
| --- | --- |
| `network-health.e2e.test.ts` | RPC outages, passphrase/protocol changes, ledger close-time drift, RPC↔Horizon skew, fee surges, Friendbot regressions |
| `stream-lifecycle.e2e.test.ts` | Contract regressions on the live protocol (`create_stream` → `withdraw` → `cancel_stream`, `getEvents`) |
| `stream-lifecycle.e2e.test.ts` › indexer | Indexer drift — the real `SorobanEventWorker` must ingest those txs into Postgres with matching hashes, ledgers and amounts |

It is **not** part of `npm test`. It runs on a schedule (every 6h) via
`.github/workflows/testnet-e2e.yml`, which deploys a fresh contract from the
current `contracts/` source, runs the suite, and opens/updates a
`testnet-e2e-failure` issue when a scheduled run fails. It can also be run
manually from the Actions tab, optionally against an existing contract ID.

## Running locally

```bash
cd backend
# Network health only (no contract / DB needed):
npm run test:e2e:testnet -- network-health

# Full suite: deploy a contract, then point the suite at it and a Postgres DB
export E2E_STREAM_CONTRACT_ID=C...
export DATABASE_URL=postgresql://flowfi:flowfi_dev_password@127.0.0.1:5433/flowfi
npx prisma db push --schema=prisma/schema.prisma
npm run test:e2e:testnet
```

The indexer test **resets the `IndexerState` cursor** in the target database —
never point `DATABASE_URL` at a shared or production database.

Contract tests are skipped when `E2E_STREAM_CONTRACT_ID` is unset; indexer
tests are skipped when `DATABASE_URL` is unset.

## Configuration

| Variable | Default |
| --- | --- |
| `E2E_SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` |
| `E2E_HORIZON_URL` | `https://horizon-testnet.stellar.org` |
| `E2E_FRIENDBOT_URL` | `https://friendbot.stellar.org` |
| `E2E_NETWORK_PASSPHRASE` | Testnet passphrase |
| `E2E_STREAM_CONTRACT_ID` | _(unset → contract suites skipped)_ |
| `E2E_MAX_LEDGER_CLOSE_SECONDS` | `15` |
| `E2E_MAX_P90_INCLUSION_FEE` | `100000` stroops |
| `E2E_TX_TIMEOUT_MS` | `90000` |
| `E2E_INDEXER_TIMEOUT_MS` | `120000` |
