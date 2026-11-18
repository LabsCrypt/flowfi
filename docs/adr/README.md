# Architecture Decision Records (ADRs)

This directory holds FlowFi's formal architecture decisions in
[MADR](https://adr.github.io/madr/) (Markdown ADR) format. Rationale that used
to live in commit messages and ad-hoc audit notes is recorded here so new
contributors, enterprise payroll clients, and security auditors can understand
*why* the system looks the way it does — not just *what* it does.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-soroban-storage-ttl-bump-strategy.md) | Soroban storage TTL bump strategy | Accepted |
| [0002](0002-keeper-key-deprecation-client-side-signing.md) | Keeper-key deprecation & client-side signing | Accepted |
| [0003](0003-event-indexer-cursor-pagination-and-dead-letter.md) | Event indexer cursor pagination & dead-letter handling | Accepted |
| [0004](0004-realtime-transport-sse-and-websocket-coexistence.md) | Realtime transport: SSE + WebSocket coexistence | Accepted |

## Process

1. Propose a new ADR as `docs/adr/NNNN-short-title.md` using the MADR template
   (Status / Context / Decision / Consequences).
2. Link related issues, audits (`docs/audits/`), and code paths.
3. Mark superseded ADRs as `Superseded by ADR-XXXX`, never delete them.
4. Reference ADRs from `docs/ARCHITECTURE.md` and the root `README.md` so
   auditors can find them.

## Related

- [System architecture](../ARCHITECTURE.md)
- [STRIDE threat model](../security/STRIDE_THREAT_MODEL.md)
- [Keeper-key blast radius audit](../audits/1274-keeper-key-blast-radius.md)
