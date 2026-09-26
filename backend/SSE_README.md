# FlowFi Real-Time Event Streaming & Indexer Overview

This document provides a quick index for real-time event streaming via Server-Sent Events (SSE) and on-chain Soroban event indexing in the FlowFi backend.

## Documentation Map

- **[SSE Architecture Overview](docs/SSE_ARCHITECTURE.md)**: Details the architecture, system flow, connection handling, subscription filtering, horizontal scaling with Redis, event broadcasting logic, memory capacity, and security layers.
- **[Operational Runbook](docs/SSE_ARCHITECTURE.md#operational-runbook)**: **Full operational runbook** covering health check endpoints (`/health` and `/v1/admin/metrics`), lag monitoring thresholds, indexer environment variables, admin reset vs. replay procedures, deduplication guarantees, and the RPC outage recovery walkthrough.
- **[SSE Client Implementation Guide](docs/SSE_IMPLEMENTATION.md)**: Describes client integration (`GET /events/subscribe`), supported query parameters (`streams`, `users`, `all`), event types (`stream.created`, `stream.topped_up`, etc.), reconnection strategies, and code examples.

## Quick Endpoint Reference

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | `GET` | Public | Liveness and readiness check. Reports `indexerLag` and returns `503` if lag exceeds 60s while enabled. |
| `/v1/admin/metrics` | `GET` | Admin JWT | Detailed health metrics including `indexer.lastLedger`, `indexer.lagSeconds`, and `sse.activeConnections`. |
| `/v1/admin/indexer/reset` | `POST` | Admin JWT | Reset indexer `lastLedger` pointer for the next scheduled poll cycle. |
| `/v1/admin/indexer/replay` | `POST` | Admin JWT | Reset `lastLedger` pointer and immediately trigger event polling batch. |
| `/events/subscribe` | `GET` | Public / Auth | Connect to real-time Server-Sent Events stream. |

For detailed operational guidance and troubleshooting, refer to the [Operational Runbook](docs/SSE_ARCHITECTURE.md#operational-runbook).
