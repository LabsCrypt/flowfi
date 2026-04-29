````md
# Development Guide

This guide is intended to let a new contributor run the full FlowFi stack from a fresh clone.

---

## Prerequisites

Required:

- Rust toolchain (stable via rustup)
- Node.js 20+
- npm
- PostgreSQL 14+
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
````

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

```

---

If you want next-level polish, I can turn this into:
- a **Makefile / task runner setup (one-command dev start)**
- or a **Dockerized full-stack dev environment (zero manual setup)**
```
