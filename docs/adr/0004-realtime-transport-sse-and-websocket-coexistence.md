# ADR 0004: Realtime Transport — SSE + WebSocket Coexistence

- Status: Accepted
- Date: 2026-09-25
- Deciders: FlowFi core (backend + frontend)
- Related: `backend/src/services/sse.service.ts`, `backend/src/controllers/sse.controller.ts`,
  `backend/docs/SSE_ARCHITECTURE.md`, `frontend/src/hooks/useStreamEvents.ts`

## Context

Stream lifecycle updates (created/topped-up/withdrawn/cancelled/completed/
paused/resumed/closed) must reach dashboards in near-real time across
single-instance dev and multi-instance production. Requirements:

1. Server→client push with automatic reconnection and per-stream/per-user channels.
2. Horizontal scaling without sticky sessions.
3. Minimal client complexity (dashboard is read-mostly; no client→client messaging).
4. Future interactive needs (presence, typing, collaborative triage) may need
   bidirectional transport.

SSE alone covers 1–3; WebSockets cover 4 but add connection-state, auth, and
scaling complexity for a workload that is overwhelmingly one-way.

## Decision

**SSE as the primary realtime transport; WebSockets reserved for future
bidirectional features. Both coexist behind the same event bus.**

1. **SSE by default.** `GET /events/subscribe` (EventSource) serves
   `stream.*` / `user:*` / admin channels via `sse.service.ts`. Frontend
   `useStreamEvents` consumes REST for initial state + SSE for deltas.
2. **Redis Pub/Sub fanout for multi-instance.** Originating instance publishes
   to `sse:stream:<id>` / `sse:user:<address>`; all instances `psubscribe` and
   rebroadcast to local clients. No sticky sessions required.
3. **Backpressure + limits.** Max 10k connections/server, 5/IP, 10/user;
   slow clients (≥64KB buffer) are dropped to protect healthy consumers.
4. **WebSocket coexistence (opt-in).** A future `/ws` gateway may subscribe to
   the same Redis channels for bidirectional use cases. It must NOT replace
   SSE for lifecycle deltas; both transports consume the same
   `SorobanEventWorker → Postgres → broadcast` pipeline so ordering/dedup
   guarantees hold regardless of transport.
5. **Versioned event envelopes** (`event`, `data`, `requestId`) so SSE and WS
   clients share decoding logic.

## Consequences

Positive:

- Dashboards stay simple (EventSource + fetch) with no WS state machine.
- Horizontal scaling works today via Redis; tomorrow's WS gateway reuses the bus.
- Load shedding (per-IP caps, slow-client drops) keeps tail latency bounded.

Negative / residual:

- SSE is unidirectional — any future client→server realtime need requires the
  WS gateway (accepted: none exists today).
- Proxies that buffer SSE break streaming (mitigated with `text/event-stream`
  headers, `X-Accel-Buffering: no`, and documented nginx config).
- Two transports means two auth paths to audit (SSE Bearer JWT today; WS ticket
  auth when built).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| WebSockets only | Overkill for one-way deltas; harder auth/reconnect/scale story for dashboard use |
| Polling only | Latency + DB load; misses sub-second payroll UX |
| External pub/sub (Pusher/Ably) | Vendor lock + cost + data-sovereignty concerns for payroll data |
