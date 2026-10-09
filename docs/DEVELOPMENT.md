# Development Guide

This guide is intended to let a new contributor run the full FlowFi stack from a fresh clone.

---

## ⚡ One-Click Mock Development Sandbox

> **Recommended for new contributors.** No wallet, no testnet funding, no live RPC needed.

Spin up the complete FlowFi stack — Postgres, Redis, mock Soroban RPC, backend (sandbox mode), and frontend — with rich pre-seeded demo data in a single command:

```bash
# From the repo root
npm install          # only needed once
npm run dev:mock
```

That one command:

1. **Starts infrastructure** — Postgres, Redis, and a mock Soroban RPC stub via Docker Compose.
2. **Syncs the database schema** — runs `prisma db push` against the fresh local DB (the committed init migration doesn't apply cleanly to an empty database, so the sandbox pushes the schema directly instead of replaying migration history).
3. **Seeds 20 demo streams** across 5 mock users, with event histories spanning the last 30 days:
   - 7 Active streams (USDC, EURC, XLM)
   - 3 Paused streams (pending milestone review)
   - 3 Completed streams (fully drained)
   - 3 Cancelled streams
   - 4 Vesting-cliff streams
4. **Starts the backend** in sandbox mode at `http://localhost:3001`.
5. **Starts the frontend** at `http://localhost:3000`.

### What you get

| Service | URL |
|---|---|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:3001/v1 |
| Interactive API Docs | http://localhost:3001/api-docs |
| Health check | http://localhost:3001/health |
| Postgres | localhost:5433 |
| Redis | localhost:6379 |
| Mock Soroban RPC | http://localhost:8000 |

### Seeded mock users

All streams are distributed across 5 demo wallets you can use for UI testing:

| Label | Public Key (truncated) |
|---|---|
| Alice (DAO Treasury) | `GAAZI4TCR3TY5…` |
| Bob (Protocol Dev) | `GCEZWKCA5VLDN…` |
| Carol (Frontend Dev) | `GBDEVU63Y6NTH…` |
| Dave (Security Auditor) | `GDQERENWDDSQZ…` |
| Eve (Investor) | `GCVW5GBIANS67…` |

### No wallet required

Because the backend runs in **sandbox mode** and the Soroban RPC is mocked, you can:

- Browse all stream states and event histories without connecting a real Stellar wallet.
- Test UI features (create, pause, cancel, withdraw flows) using the seeded data.
- Trigger sandbox API calls via the Swagger UI at `/api-docs`.

### Stopping the sandbox

```bash
# Stop Node processes with Ctrl+C, then tear down Docker services:
docker compose down

# To also wipe the database volume (full reset):
docker compose down -v
```

### Re-seeding

If you want to reset and re-seed from scratch:

```bash
docker compose down -v
npm run dev:mock
```

### Prerequisites for the sandbox

- Docker & Docker Compose (for Postgres, Redis, mock RPC)
- Node.js 20+ and npm (for backend, frontend, seed script)

No Rust, no Stellar CLI, no testnet account needed.

---

## Prerequisites

Required:

- Rust toolchain (stable via rustup)
- Node.js 20+
- npm
- PostgreSQL 16 (matches the version pinned in `docker-compose.yml` and CI)
- Docker & Docker Compose (recommended for local infra)
- Stellar CLI / Soroban CLI (https://github.com/stellar/stellar-cli)

Optional:

- Redis 7+ (for multi-instance SSE testing)

---

## Quick Start (Recommended)

### 1. Clone repository

```bash
git clone https://github.com/LabsCrypt/flowfi.git
cd flowfi
```

---

### 2. Start infrastructure

```bash
docker compose up -d postgres
```

(Optional for SSE fanout testing)

```bash
docker compose up -d redis
```

---

### 3. Backend setup

```bash
cd backend
npm install
cp .env.example .env
```

Configure `.env`:

* DATABASE_URL
* JWT_SECRET
* STELLAR_NETWORK=testnet
* REDIS_URL (optional)

Run database setup:

```bash
npm run prisma:generate
npm run prisma:migrate
```

These commands read their paths and connection string from `backend/prisma.config.ts`, which configures the Prisma CLI separately from the data model in `backend/prisma/schema.prisma`. See [Prisma Database](../backend/README.md#prismaconfigts-vs-prismaschemaprisma) in the backend README for what each file owns and what to check when a `generate`/`migrate` command misbehaves.

Start backend:

```bash
npm run dev
```

Backend runs at:

* [http://localhost:3001/v1](http://localhost:3001/v1)
* [http://localhost:3001/health](http://localhost:3001/health)

---

### 4. Frontend setup

```bash
cd frontend
npm install
npm run dev
```

Frontend:

* [http://localhost:3000](http://localhost:3000)

---

### 5. Contracts (optional)

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
cargo test
```

---

## Full Stack Setup (Detailed Mode)

### Backend

```bash
cd backend
npm ci
npm run dev
```

### Frontend

```bash
cd frontend
npm ci
npm run dev
```

### Database

```bash
docker compose up -d postgres
```

---

## Running Tests

Backend:

```bash
cd backend
npm test
```

Frontend:

```bash
cd frontend
npm run lint
npm test
npm run test:coverage
```

Contracts:

```bash
cd contracts
cargo test
```

---

## Testnet vs Local Mode

Configure in `.env`:

* `STELLAR_NETWORK=testnet`
* `SANDBOX_MODE_ENABLED=true` (optional)
* `STELLAR_HORIZON_URL` (if needed)

---

## Common Issues

### Indexer not syncing

* Ensure worker/indexer is running
* Confirm correct Stellar network (testnet/mainnet)
* Check DB cursor/state
* Review logs for RPC/Horizon errors

---

### SSE issues

* Verify JWT token validity
* Check `/v1/events/stats`
* Ensure Redis is running (multi-instance mode)
* Confirm connection limits are not exceeded

---

### Auth failures (401/403)

* Ensure wallet signature matches public key
* Verify `JWT_SECRET`
* Confirm Bearer token is included

---

### Database migration issues

* Check `DATABASE_URL`
* Run `prisma generate`
* Reset DB if schema drift occurs
* Check `backend/prisma.config.ts` — it sets the schema path, migrations path, and the `DATABASE_URL` the CLI uses ([details](../backend/README.md#troubleshooting))

---

## Suggested Day-1 Flow

1. Start Postgres (and Redis if needed)
2. Run backend migrations
3. Start backend
4. Start frontend
5. Create a stream and verify SSE updates

---

## Legacy Quick Setup (Minimal)

```bash
docker compose up -d
cd backend && npm ci && npm run dev
cd frontend && npm ci && npm run dev
```

---

## Contracts Build Only

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

---

## Links

* Architecture: `ARCHITECTURE.md`
* Backend: `backend/`
* Frontend: `frontend/`
* Contracts: `contracts/stream_contract`
