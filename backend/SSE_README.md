# FlowFi Real-Time Event Streaming & Indexer Overview

This document provides a quick index for real-time event streaming via Server-Sent Events (SSE) and on-chain Soroban event indexing in the FlowFi backend.

## Documentation Map

- **[SSE Architecture Overview](docs/SSE_ARCHITECTURE.md)**: Details the architecture, system flow, connection handling, subscription filtering, horizontal scaling with Redis, event broadcasting logic, memory capacity, and security layers.
- **[Operational Runbook](docs/SSE_ARCHITECTURE.md#operational-runbook)**: Full operational runbook covering health checks, lag monitoring, indexer reset/replay procedures, deduplication, and RPC outage recovery.
- **[SSE Client Implementation Guide](docs/SSE_IMPLEMENTATION.md)**: Describes client integration with the versioned SSE endpoint, supported query parameters, event types, and reconnection strategies.

## Production Considerations

The following production safeguards are shipped and should not be treated as TODOs:

- [x] JWT authentication — enforced by the authenticated v1 event/stream routes and the backend authentication middleware.
- [x] Per-IP connection limits — enforced by the SSE connection-limiting middleware before subscriptions are opened.
- [x] Redis pub/sub — implemented by the SSE service for multi-instance event delivery.

Remaining operational work, such as reverse-proxy/DDoS hardening and alert tuning, remains deployment-specific TODO work.

## Quick Endpoint Reference

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | `GET` | Public | Liveness and readiness check. Reports `indexerLag` and returns `503` if lag exceeds 60s while enabled. |
| `/v1/admin/metrics` | `GET` | Admin JWT | Detailed health metrics including `indexer.lastLedger`, `indexer.lagSeconds`, and `sse.activeConnections`. |
| `/v1/admin/indexer/reset` | `POST` | Admin JWT | Reset the indexer `lastLedger` pointer for the next scheduled poll cycle. |
| `/v1/admin/indexer/replay` | `POST` | Admin JWT | Reset `lastLedger` and immediately trigger an event polling batch. |
| `/v1/events/subscribe` | `GET` | JWT | Connect to the versioned real-time Server-Sent Events stream. |
| `/v1/streams` | `GET`/`POST` | JWT | Read and create streams through the authenticated v1 API. |

### Authenticated v1 examples

```bash
# Subscribe to selected stream events
curl -N -H "Authorization: Bearer <JWT>" \
  "http://localhost:3001/v1/events/subscribe?streams=1&streams=2"

# Use the versioned stream API
curl -H "Authorization: Bearer <JWT>" \
  "http://localhost:3001/v1/streams"
```

The former unversioned `/events/subscribe` route is deprecated, requires a JWT, and returns `410 Gone`. Use `/v1/events/subscribe` instead. For detailed operational guidance and troubleshooting, refer to the [Operational Runbook](docs/SSE_ARCHITECTURE.md#operational-runbook).
