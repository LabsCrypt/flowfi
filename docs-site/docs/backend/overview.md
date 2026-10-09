---
title: Backend & Indexer overview
---

# Backend & Indexer overview

The Express backend is the read/write surface the frontend talks to, plus the
indexer that mirrors chain state into PostgreSQL.

## Responsibilities

1. **REST API** (`/api/v1/...`) — invoice/stream CRUD, withdraw proxy, user
   summaries, and (#1480) the analytics endpoints.
2. **Event ingestion** — a worker tails Soroban events and writes them to
   Postgres (see [event ingestion](/backend/event-ingestion)).
3. **Real-time fan-out** — SSE (and WebSocket) push indexed events to the
   dashboard ([streams & SSE](/backend/streams-sse)).
4. **Webhooks** — signed outbound deliveries with exponential-backoff retry
   and a dead-letter queue ([webhooks](/backend/webhooks),
   [dead-letter triage](/backend/dead-letter-triage)).
5. **Analytics** — TimescaleDB-backed TVL/velocity
   ([analytics](/backend/analytics)).

## Layout

```
backend/src/
  app.ts               # express app assembly
  controllers/         # HTTP handlers
  services/            # business logic (analytics.service.ts is #1480)
  routes/v1/           # versioned routers
  repositories/        # prisma access layer
  workers/             # soroban event worker
  lib/                 # prisma, pg pool, redis, metrics
```

Run locally with `npm run dev:mvp` in `backend/` — see the repo README for
database setup.
