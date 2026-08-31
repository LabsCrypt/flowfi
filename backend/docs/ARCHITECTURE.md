# Backend Architecture

This document describes backend ownership, data flow, and authorization for
contributors working on the indexer, SSE, and keeper-key paths.

For the full system overview (contract -> worker -> DB -> API -> frontend),
see the [root architecture docs](../../docs/ARCHITECTURE.md).

## 1. Indexer Ownership (Source of Truth)

### 1.1 Which indexer is authoritative?

| File | Class / export | Role | Status |
|------|---------------|------|--------|
| `backend/src/workers/soroban-event-worker.ts` | `SorobanEventWorker` / `sorobanEventWorker` | **Source-of-truth indexer.** Polls Soroban RPC (`getEvents`), decodes XDR topics/values, persists `Stream` + `StreamEvent`, advances `IndexerState`, and broadcasts SSE. | **Active — authoritative** |
| `backend/src/services/soroban-indexer.service.ts` | `SorobanIndexerService` / `sorobanIndexerService` | Legacy duplicate poller that hits the same RPC endpoint and writes the same tables. | **Deprecated — do not extend.** Kept for API/test compatibility only. Marked `@deprecated` at `backend/src/services/soroban-indexer.service.ts:13`. Removal tracked under the dual-indexer consolidation (Architecture #67 / issue #801). |
| `backend/src/services/indexerService.ts` | `indexerService.ts` / `indexer.service` barrel | **Not an indexer.** Control-plane helpers (`getIndexerStatus`, `resetIndexer`, `replayFromLedger`) that read/reset the singleton `IndexerState` row and trigger the worker via `sorobanEventWorker.triggerPoll()`. | Active — control plane only. Misleading name; expected to be renamed to `indexer.service.ts` after consolidation (see `docs/ARCHITECTURE.md` naming convention note). |

**Rule: when debugging indexing, start at `backend/src/workers/soroban-event-worker.ts`.**
Do not add new behavior to `soroban-indexer.service.ts`.

### 1.2 Why two indexers exist

The codebase historically had two independent poll loops:

- `SorobanEventWorker` — started via `backend/src/workers/index.ts:16` → `sorobanEventWorker.start()` after DB/Redis connect.
- `SorobanIndexerService` — a standalone class with its own `setInterval(fetch)` that was started directly from application entry points.

Both write to the same `IndexerState` singleton (`id = "singleton"`) and the same
`Stream` / `StreamEvent` tables. Running both concurrently can race on
`IndexerState.lastLedger` / `lastCursor` and on stream state mutations.
This is the known dual-indexer race (Architecture #67 / issue #801).

**Current ownership model:** `SorobanEventWorker` is the only indexer started
by `backend/src/index.ts` via `startWorkers()`. `SorobanIndexerService` is not
started in production; it remains exported so existing tests (`backend/tests/soroban-indexer.test.ts`)
and any external importers continue to compile. Treat any startup call to
`sorobanIndexerService.start()` outside tests as a bug.

### 1.3 Indexer cursor & idempotency

- Progress is tracked in the single-row `IndexerState` table (`backend/prisma/schema.prisma:60`).
  `ensureIndexerState()` (`backend/src/lib/indexer-state.ts`) creates the row
  with `INDEXER_START_LEDGER` on cold start and handles the `P2002` race on
  concurrent first-insert.
- Polling prefers cursor-based pagination (`lastCursor` / `event.id`) after the
  first batch; `startLedger` is only used on cold start (`backend/src/workers/soroban-event-worker.ts:335`).
- `StreamEvent` has `@@unique([transactionHash, eventType])` (`backend/prisma/schema.prisma:82`).
  The worker uses `findUnique` + `upsert` (or early-return on duplicate) keyed on
  that pair, so replaying a ledger range is safe against duplicate event rows.
  Stream-entity mutations for `TOPPED_UP` / `WITHDRAWN` are guarded by a
  pre-mutation duplicate check as well (see `handleStreamToppedUp` / `handleTokensWithdrawn`).
- Replay is triggered via `POST /v1/admin/indexer/replay` → `replayFromLedger()` →
  `resetIndexer()` + `sorobanEventWorker.triggerPoll()`. Batches are serialized
  through `runExclusive()` / `batchMutex` so two cursor writes cannot overlap
  (`backend/src/workers/soroban-event-worker.ts:234`).

For operational details (health thresholds, reset vs replay, RPC-outage runbook)
see [SSE Architecture — Operational Runbook](SSE_ARCHITECTURE.md#operational-runbook).

## 2. SSE Broadcast Flow

```
Soroban RPC  ──poll──►  SorobanEventWorker  ──persist──►  PostgreSQL (Stream / StreamEvent / IndexerState)
                                │
                                │  sseService.broadcastToStream / broadcastToUser / broadcastToAdmin
                                ▼
                          SSE Service  ──Redis pub/sub (if available)──►  all API instances
                                │
                                ▼
                     GET /events/subscribe  (text/event-stream)
                                │
                                ▼
                           Browser clients
```

Key points:

- **Indexer-driven origin.** SSE events originate asynchronously from
  `SorobanEventWorker` (and `StreamRunwayWorker` for alerts like
  `STREAM_LOW_BALANCE`) only after on-chain confirmation. HTTP API controllers
  (`stream.controller.ts`, etc.) never broadcast SSE directly
  (see `backend/docs/SSE_ARCHITECTURE.md:43`).
- **Fan-out.** `backend/src/services/sse.service.ts` keeps an in-memory client
  registry and, when `REDIS_URL` is set, publishes to `sse:stream:*` /
  `sse:user:*` channels via `backend/src/lib/redis.ts`. All instances subscribe
  via `psubscribe` and rebroadcast locally — no sticky sessions required
  (`backend/docs/SSE_ARCHITECTURE.md:106`).
- **Filtering.** `broadcastToStream(streamId, event, data)` delivers to clients
  subscribed to that stream id or `*`; `broadcastToUser(publicKey, ...)` to
  `user:<key>` or `*`; `broadcastToAdmin` resolves `ADMIN_PUBLIC_KEY` and
  delegates to `broadcastToUser` (`backend/src/services/sse.service.ts:182`).
- **Full spec, scaling, and auth notes:** [SSE_ARCHITECTURE.md](SSE_ARCHITECTURE.md)
  and [SSE_IMPLEMENTATION.md](SSE_IMPLEMENTATION.md).

## 3. Keeper-Key Authorization Model

Some contract calls are custodial (server-signed) and some are wallet-signed.
Only one flow is allowed to use the server key.

### 3.1 Model

| Action | Signer | Server path | Key |
|--------|--------|-------------|-----|
| **Top-up** | Server (custodial) | `topUpStream()` in `backend/src/services/sorobanService.ts:365` | `KEEPER_SECRET_KEY` |
| **Cancel** | Server (custodial, via `KEEPER_SECRET_KEY`) | `backend/src/controllers/stream/cancel.ts:90` | `KEEPER_SECRET_KEY` |
| **Withdraw** | Wallet (non-custodial) | Backend only simulates (`simulateContractCall('withdraw', …)`) — real tx is signed/submitted by the frontend wallet (Freighter) | — |
| **Pause / Resume** | Wallet (non-custodial) | Backend only simulates (`pauseStream` / `resumeStream`) — real tx is wallet-signed | — |
| **Create stream** | Wallet (non-custodial) | Frontend signs and submits directly to RPC | — |

Contributors must not wire pause/resume/withdraw to a server-side submit path.
See also `docs/ARCHITECTURE.md` § "Action Signing Model".

### 3.2 Keeper key handling (Architecture #72)

- The keeper key is read from `KEEPER_SECRET_KEY` (`backend/src/services/sorobanService.ts:10`
  and `backend/src/controllers/stream/cancel.ts:90`). It is a Stellar secret
  seed (`S…`) loaded from the environment — never from the DB or the client.
- `topUpStream(streamId, amount, callerAddress)` (`backend/src/services/sorobanService.ts:365`)
  throws `KEEPER_SECRET_KEY not configured` when unset and otherwise calls
  `submitContractCall('top_up_stream', [streamId, amount, callerAddress], keeperSecret)`.
- Key scope: the keeper is the only server-side signer. All other mutating
  actions are verified only by the contract (wallet signature) and the API
  validates the caller via JWT (`backend/docs/AUTHENTICATION.md`) before
  simulating.
- Operational guidance: set `KEEPER_SECRET_KEY` only in the backend environment
  (see `backend/.env.example:44` and `render.yaml:44`). Do not expose it to the
  frontend (`NEXT_PUBLIC_*`) and do not log it.

## 4. References

- Root system design: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
- Indexer ownership & naming (canonical): [docs/ARCHITECTURE.md#event-indexing--real-time-updates](../../docs/ARCHITECTURE.md#event-indexing--real-time-updates)
- SSE architecture & runbook: [SSE_ARCHITECTURE.md](SSE_ARCHITECTURE.md)
- SSE implementation details: [SSE_IMPLEMENTATION.md](SSE_IMPLEMENTATION.md)
- Auth flow: [AUTHENTICATION.md](AUTHENTICATION.md)
- Control-plane code: `backend/src/services/indexerService.ts` (delegates to `indexer.service.ts`), `backend/src/workers/soroban-event-worker.ts:206`, `backend/src/lib/indexer-state.ts`
- Legacy indexer: `backend/src/services/soroban-indexer.service.ts:13`
