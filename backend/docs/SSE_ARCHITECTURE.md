# SSE Architecture Overview

## System Flow

```
┌─────────────────────────────────────────────────────────┐
│              Stellar Blockchain / Soroban                │
│  - On-chain stream contract executions & ledger events   │
└────────────────────────────┬────────────────────────────┘
                             │ On-Chain Events (via Soroban RPC poll)
                             ▼
┌─────────────────────────────────────────────────────────┐
│                    Backend Server                        │
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Soroban Event Worker (Indexer)                  │  │
│  │  - Polls Soroban RPC for confirmed events        │  │
│  │  - Persists stream state & events to Database    │  │
│  │  - Calls sseService.broadcastToStream/Admin()     │  │
│  └──────────────┬───────────────────────────────────┘  │
│                 │ Dispatch events (indexer-driven)       │
│                 ▼                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │  SSE Service                                      │  │
│  │  - Manages client connections                     │  │
│  │  - Filters by subscription (stream/user/admin)    │  │
│  │  - Broadcasts to matching clients                 │  │
│  └──────────────┬───────────────────────────────────┘  │
│                 │                                        │
└─────────────────┼────────────────────────────────────────┘
                  │ SSE Events
                  ▼
    ┌─────────────────────────────────────┐
    │         Multiple Clients            │
    │                                     │
    │  ┌──────────┐  ┌──────────┐       │
    │  │ Browser  │  │ Browser  │  ...  │
    │  │ Client 1 │  │ Client 2 │       │
    │  └──────────┘  └──────────┘       │
    └─────────────────────────────────────┘
```

> **Note on Indexer-Driven Event Origin**: SSE broadcast events originate asynchronously from the background indexer worker (`SorobanEventWorker`) only after transaction confirmation on the Stellar ledger, not synchronously from HTTP API controllers (`stream.controller.ts`, etc.). When a user submits an action (create, pause, withdraw, top-up, cancel), API controllers do not broadcast SSE events directly; events are dispatched once the Soroban event is polled and confirmed on-chain. Additionally, background workers like `StreamRunwayWorker` may dispatch computed alerts (e.g. `STREAM_LOW_BALANCE`).

## Connection Flow

```
Client                          Server
  │                               │
  │  GET /events/subscribe        │
  │  ?streams=1&streams=2         │
  ├──────────────────────────────>│
  │                               │
  │  200 OK                       │
  │  Content-Type:                │
  │    text/event-stream          │
  │<──────────────────────────────┤
  │                               │
  │  data: {"type":"connected"}   │
  │<──────────────────────────────┤
  │                               │
  │         [Connected]           │
  │                               │
  │  event: stream.created        │
  │  data: {...}                  │
  │<──────────────────────────────┤
  │                               │
  │  event: stream.withdrawn      │
  │  data: {...}                  │
  │<──────────────────────────────┤
  │                               │
  │         [Connection Lost]     │
  │                               │
  │  [Auto Reconnect - 1s]        │
  │                               │
  │  GET /events/subscribe        │
  │  ├──────────────────────────────>│
  │                               │
  │  200 OK                       │
  │<──────────────────────────────┤
  │                               │
  │         [Reconnected]         │
```

## Subscription Filtering

```
┌─────────────────────────────────────────────────────┐
│                   SSE Service                        │
│                                                      │
│  Client Map:                                         │
│  ┌────────────────────────────────────────────────┐ │
│  │ client-1: { subscriptions: ["1", "2"] }        │ │
│  │ client-2: { subscriptions: ["user:GABC..."] } │ │
│  │ client-3: { subscriptions: ["*"] }             │ │
│  └────────────────────────────────────────────────┘ │
│                                                      │
│  Event: stream.created (streamId: "1")              │
│  ↓                                                   │
│  Filter: clients with "1" or "*"                    │
│  ↓                                                   │
│  Broadcast to: client-1, client-3                   │
└─────────────────────────────────────────────────────┘
```

## Horizontal Scaling with Redis

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│  Backend 1   │      │  Backend 2   │      │  Backend 3   │
│              │      │              │      │              │
│  SSE Service │      │  SSE Service │      │  SSE Service │
│  (10 clients)│      │  (15 clients)│      │  (8 clients) │
└──────┬───────┘      └──────┬───────┘      └──────┬───────┘
       │                     │                     │
       │ Publish             │ Subscribe           │
       └─────────────────────┼─────────────────────┘
                             │
                    ┌────────▼────────┐
                    │  Redis Pub/Sub  │
                    │                 │
                    │  Channel:       │
                    │  stream-events  │
                    └─────────────────┘

Flow:
1. Backend 1 (SorobanEventWorker) indexes confirmed on-chain event
2. Backend 1 publishes to Redis: "stream-events"
3. All backends (1, 2, 3) receive message via Redis subscriber
4. Each backend broadcasts to its connected clients
5. Total: 33 clients receive the event
```

## Event Broadcasting Logic

```typescript
// Broadcast to specific stream (called by SorobanEventWorker / StreamRunwayWorker)
sseService.broadcastToStream("123", "stream.created", data)
  ↓
  Filter clients: subscription includes "123" or "*"
  ↓
  Send to matching clients

// Broadcast to user (called by StreamRunwayWorker)
sseService.broadcastToUser("GABC...", "STREAM_LOW_BALANCE", data)
  ↓
  Filter clients: subscription includes "user:GABC..." or "*"
  ↓
  Send to matching clients

// Broadcast to admin (called by SorobanEventWorker for admin/fee events)
sseService.broadcastToAdmin("stream.fee_config_updated", data)
  ↓
  Filter clients: admin subscribers ("admin" or "*")
  ↓
  Send to matching clients

// Broadcast to all
sseService.broadcast("stream.created", data)
  ↓
  Send to all connected clients
```

## Memory & Performance

```
Single Instance Capacity:

Connections    Memory    CPU (idle)    CPU (1K events/s)
─────────────────────────────────────────────────────────
100            1 MB      <1%           <5%
1,000          10 MB     <1%           ~10%
10,000         100 MB    ~2%           ~30%
50,000         500 MB    ~5%           ~80%

Bottlenecks:
- Network I/O (primary)
- Memory per connection (~10KB)
- Event serialization (JSON.stringify)

Optimization:
- Use Redis for multi-instance
- Implement connection pooling
- Add message batching for high-frequency events
```

## Security Layers

```
┌─────────────────────────────────────────────────┐
│  Reverse Proxy (nginx/CloudFlare)              │
│  - Rate limiting (connections per IP)          │
│  - DDoS protection                              │
│  - SSL termination                              │
└─────────────────┬───────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────┐
│  Backend Middleware                             │
│  - JWT authentication                           │
│  - Connection limits per user                   │
│  - Subscription validation                      │
└─────────────────┬───────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────┐
│  SSE Service                                    │
│  - Client tracking                              │
│  - Auto cleanup on disconnect                   │
│  - Subscription filtering                       │
└─────────────────────────────────────────────────┘
```

## Operational Runbook

This section details operational procedures, health monitoring metrics, environment configuration, and recovery workflows for the indexer and real-time event streaming components.

### Monitoring & Health Check

The backend exposes two primary endpoints for observing indexer health and operational metrics.

#### 1. Liveness & Readiness Health Endpoint (`GET /health`)

Unauthenticated health endpoint suitable for load balancer probes, Kubernetes liveness/readiness checks, and monitoring alerts.

* **URL**: `GET /health`
* **Response Schema**:
  ```json
  {
    "status": "ok",
    "db": "connected",
    "indexerEnabled": true,
    "indexerLag": 5,
    "uptime": 3600
  }
  ```
* **Key Fields**:
  * `status`: `"ok"` (healthy) or `"degraded"` (unhealthy / degraded).
  * `db`: `"connected"` or `"disconnected"`.
  * `indexerEnabled`: `true` if `STREAM_CONTRACT_ID` is set, `false` if unconfigured/disabled.
  * `indexerLag`: Integer seconds since last indexer DB state update (`updatedAt`), or `null` on cold start (when no `IndexerState` row exists yet).
  * `uptime`: Node process uptime in seconds.
* **Threshold & Status Logic**:
  * **HTTP 200 OK** (`status: "ok"`): DB status is `"connected"` and `indexerDegraded` is `false`.
  * **HTTP 503 Service Unavailable** (`status: "degraded"`): Triggered if DB status is `"disconnected"` OR `indexerDegraded` is `true`.
  * **Degraded Rule**: `indexerDegraded = indexerEnabled && indexerLag > 60` (indexer enabled and lag strictly exceeds 60 seconds).
  * **Cold Start Handling**: If no `IndexerState` record exists in the database (`indexerLag === -1` internally), `indexerLag` is returned as `null` and does **not** trigger degradation (returns HTTP 200 OK as long as DB is connected).
  * **Disabled Handling**: If `STREAM_CONTRACT_ID` is unset (`indexerEnabled: false`), lag degradation checks are bypassed and `/health` returns HTTP 200 OK.

##### On-Call Operational Actions by Health Status

| `indexerLag` Value | HTTP Status | Operational Status | On-Call Action |
|-------------------|-------------|--------------------|----------------|
| `indexerLag <= 60s` | `200 OK` | **Healthy** | Normal operation. |
| `indexerLag > 60s` | `503 Service Unavailable` | **Degraded** | Indexer is stale or stalled. Check Soroban RPC connectivity (`SOROBAN_RPC_URL`), worker logs (`[SorobanWorker]`), and DB load. If RPC went down, execute the RPC Outage Recovery workflow below. |
| `indexerLag: null` | `200 OK` | **Cold Start** | Indexer state record has not yet been created. Wait for initial poll cycle to complete. |

#### 2. Admin Health Metrics Endpoint (`GET /v1/admin/metrics`)

Authenticated endpoint providing detailed protocol counters, cache status, active SSE connections, and indexer state.

* **URL**: `GET /v1/admin/metrics`
* **Authentication**: Requires Admin JWT (`requireAdmin` middleware).
* **Caching**: Cached in Redis with key `admin:metrics` for 60 seconds (`X-Cache: HIT|MISS` header returned).
* **Indexer & Realtime Payload Fields**:
  ```json
  {
    "indexer": {
      "lastLedger": 1234567,
      "lagSeconds": 5,
      "lastUpdated": "2026-07-27T01:15:00.000Z"
    },
    "sse": {
      "activeConnections": 42
    },
    "events": {
      "last24h": 1250
    }
  }
  ```
  * `indexer.lastLedger`: Last processed Stellar ledger sequence (`number`, defaults to 0).
  * `indexer.lagSeconds`: Seconds elapsed since last indexer state update (`number | null`).
  * `indexer.lastUpdated`: ISO timestamp of last indexer update (`string | null`).
  * `sse.activeConnections`: Current number of active client SSE connections.
  * `events.last24h`: Count of indexed stream events in the past 24 hours.

---

### Indexer Environment Variables

The indexer worker behavior is controlled by environment variables configured in `backend/src/workers/soroban-event-worker.ts`.

| Environment Variable | Description | Default Value | Behavior when Disabled / Unset |
|----------------------|-------------|---------------|--------------------------------|
| `STREAM_CONTRACT_ID` | Contract address of the streaming smart contract on Stellar. | `""` (empty string) | **Disables indexer worker**. On startup, `sorobanEventWorker.start()` logs `[SorobanWorker] STREAM_CONTRACT_ID is not set — event indexing disabled.` and exits gracefully without starting the polling loop. `/health` reports `indexerEnabled: false` and skips 503 lag checks. |
| `SOROBAN_RPC_URL` | Endpoint URL for the Soroban RPC node. | `"https://soroban-testnet.stellar.org"` | Uses default public testnet RPC URL. |
| `INDEXER_POLL_INTERVAL_MS` | Polling interval in milliseconds between event fetch cycles. | `"5000"` (5 seconds) | Uses default 5000 ms interval. |
| `INDEXER_START_LEDGER` | Starting Stellar ledger sequence number for cold starts when no `IndexerState` record exists in the database. | `"0"` | Starts indexing from ledger 0 on initial setup. |

---

### Admin Operations: Reset vs. Replay

The backend provides two admin endpoints for managing indexer positioning and re-processing events. Both require Admin JWT authentication (`requireAdmin`).

#### 1. Reset Indexer (`POST /v1/admin/indexer/reset`)

* **Route**: `POST /v1/admin/indexer/reset`
* **Request Body**:
  ```json
  {
    "ledger": 1234500
  }
  ```
* **Handler Behavior**:
  * Calls `resetIndexer(toLedger)` in `backend/src/services/indexerService.ts:30`.
  * Upserts the singleton row in `prisma.indexerState` (`id: "singleton"`), setting `lastLedger` to `toLedger` and `lastCursor` to `null`.
  * **Does NOT immediately trigger a poll**. The worker will pick up from `toLedger` on its next scheduled interval (`INDEXER_POLL_INTERVAL_MS`).

#### 2. Replay Indexer (`POST /v1/admin/indexer/replay`)

* **Route**: `POST /v1/admin/indexer/replay?from_ledger=1234500`
* **Query Parameter**: `from_ledger` (non-negative integer).
* **Response**: `202 Accepted` (`{ "ok": true, "replayingFrom": 1234500 }`).
* **Handler Behavior**:
  * Calls `replayFromLedger(fromLedger)` in `backend/src/services/indexerService.ts:49`.
  * Calls `resetIndexer(fromLedger)` to update `lastLedger` and clear `lastCursor`.
  * **Immediately triggers an out-of-band poll cycle** via `sorobanEventWorker.triggerPoll()` without waiting for the next polling interval timer.

#### Operational Comparison

| Feature / Scenario | Reset (`POST /v1/admin/indexer/reset`) | Replay (`POST /v1/admin/indexer/replay`) |
|--------------------|------------------------------------------|-------------------------------------------|
| **Execution** | Passive: Updates DB pointer only. | Active: Updates DB pointer **and** triggers immediate poll batch. |
| **Use Case** | Reconfiguring start ledger prior to scheduled maintenance or service restart. | Recovering from RPC outages or backfilling missed ledgers immediately. |
| **Parameters** | JSON body: `{ "ledger": <number> }` | Query param: `?from_ledger=<number>` |

#### Event Deduplication & Idempotency Guarantee

Replaying events is safe against duplicate event creation in the database:

* **Database Constraint**: Grounded in `backend/prisma/schema.prisma:83`, the `StreamEvent` model enforces a unique compound index:
  ```prisma
  @@unique([transactionHash, eventType])
  ```
* **Worker Execution**: In `backend/src/workers/soroban-event-worker.ts`, event handlers execute `prisma.streamEvent.upsert(...)` matching on `{ transactionHash_eventType: { transactionHash, eventType } }`. If an event for that transaction and type has already been recorded, the insertion is skipped.
* **Operational Note / Caveat**: As documented in `backend/src/services/indexerService.ts:44-47`, deduplication applies to `StreamEvent` log rows. Stream entity state mutations (such as `Stream.withdrawnAmount` in `handleTokensWithdrawn`) are currently updated unconditionally upon reprocessing events; full state mutation idempotency is tracked under issue #808.

---

### RPC Outage Recovery Walkthrough

When the Soroban RPC node experiences downtime or network disruption, the indexer will pause event ingestion, causing `indexerLag` on `/health` to increase beyond 60 seconds and report HTTP 503. Follow these steps to restore service:

1. **Identify the Last Processed Ledger**:
   Query the metrics endpoint to obtain the last processed ledger before the outage:
   ```bash
   curl -H "Authorization: Bearer <ADMIN_JWT>" http://localhost:3001/v1/admin/metrics
   ```
   Note `indexer.lastLedger` from the JSON response.

2. **Verify RPC Connectivity**:
   Ensure `SOROBAN_RPC_URL` is reachable and serving valid Stellar ledger data.

3. **Trigger Event Replay**:
   Call the replay endpoint passing the last known valid ledger sequence:
   ```bash
   curl -X POST -H "Authorization: Bearer <ADMIN_JWT>" \
     "http://localhost:3001/v1/admin/indexer/replay?from_ledger=<LAST_KNOWN_LEDGER>"
   ```

4. **Monitor Catch-Up Progress**:
   Continuously monitor progress via `GET /v1/admin/metrics`:
   * Observe `indexer.lastLedger` incrementing toward the current network ledger.
   * Observe `indexer.lagSeconds` decreasing.

5. **Verify Health Restoration**:
   Confirm `/health` returns HTTP `200 OK` with `status: "ok"` and `indexerLag <= 60`:
   ```bash
   curl http://localhost:3001/health
   ```

