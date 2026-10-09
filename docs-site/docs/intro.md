---
title: FlowFi protocol overview
slug: /
sidebar_position: 1
---

# FlowFi protocol overview

FlowFi is a streaming-payments protocol on Stellar Soroban. A sender escrows
tokens in the `stream_contract`; the recipient accrues them continuously
(linear, cliff, or step-tranche schedules) and withdraws whenever they like.

The pages under this portal document the whole stack:

- **Smart Contracts** — the Soroban contract: stream lifecycle, storage TTLs,
  batch operations, the emergency pause, and #1482's conditional
  (oracle/KPI-gated) milestone streams.
- **Backend & Indexer** — event ingestion into PostgreSQL, SSE/WebSocket
  fan-out, webhooks with dead-letter triage, and the TimescaleDB analytics
  stack (#1480).
- **Client SDKs** — TypeScript, React hooks, Python and Rust clients.
- **Guides** — end-to-end recipes: DAO payroll, SaaS subscription billing,
  milestone vesting for grants.
- **API Reference** — the interactive REST/OpenAPI console.

> Source of truth for behavior is the code: `contracts/stream_contract/src/`
> for on-chain semantics, `backend/src/` for the API. These pages explain the
> how and the why; the reference pages pin the exact shapes.
