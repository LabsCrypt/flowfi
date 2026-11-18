---
title: Dead-letter triage
---

# Dead-letter triage

Anything that could not be processed (event decode failure, persistence
error) or delivered (webhook attempts exhausted) lands in a dead-letter
table — never silently dropped.

## Triage loop

1. **List** — `GET /api/v1/admin/webhooks/dead-letter` (admin JWT): error
   kind, payload, attempt count, last error.
2. **Fix the cause** — most commonly a decoder drift after a contract
   upgrade, or a subscriber whose endpoint moved.
3. **Replay** — `POST /api/v1/admin/webhooks/dead-letter/:id/replay` for one
   row, or `POST .../replay-all` after a bulk fix. Replays are idempotent:
   event identity is `(contract, topic, ledger, index)`.
4. **Discard** — `POST .../:id/discard` when the payload is genuinely stale
   (recorded with who discarded it and why).

## Design rule

Replay handlers reuse the production ingest path, not a copy — a bug fixed
for replay is a bug fixed for live traffic.
