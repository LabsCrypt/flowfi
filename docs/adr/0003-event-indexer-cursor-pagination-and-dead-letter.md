# ADR 0003: Event Indexer Cursor Pagination & Dead-Letter Handling

- Status: Accepted
- Date: 2026-09-25
- Deciders: FlowFi core (backend + contracts)
- Related: `backend/src/workers/soroban-event-worker.ts`,
  `backend/src/services/indexerService.ts`, `IndexerState` / `StreamEvent` models,
  `backend/tests/events-wire-format.test.ts`

## Context

The Soroban RPC returns contract events in ledger-ordered pages with opaque
cursors. The backend must mirror every `stream_created / topped_up / withdrawn /
cancelled / completed / paused / resumed / closed / fee_collected` event into
Postgres (`Stream` + `StreamEvent`) exactly once, then fan out over SSE —
across restarts, replays, and multi-instance deployments.

Failure modes observed:

1. Restart replays re-inserting duplicate `StreamEvent` rows.
2. A poison event (undecodable XDR / unknown shape) halting the whole poll loop.
3. Two pollers (`SorobanEventWorker` + legacy `SorobanIndexerService`) racing on
   the same rows (issue #801).
4. Cursor loss causing full re-scans or skipped ledgers.

## Decision

1. **Single source-of-truth indexer.** `SorobanEventWorker`
   (`backend/src/workers/soroban-event-worker.ts`) owns polling, XDR decoding,
   persistence, cursor advancement, and SSE broadcast. `indexerService.ts` is
   control-plane only (status/reset/replay). The legacy
   `soroban-indexer.service.ts` is frozen and slated for removal (#801).
2. **Durable cursor in `IndexerState`.** Each poll cycle: read
   `lastIndexedLedger` → fetch `(cursor, latestLedger]` → persist → advance
   cursor. Cold start begins from configured genesis ledger for backfill.
3. **Cursor pagination, not offsets.** Follow RPC `cursor` paging within a poll
   batch; never assume a fixed page size.
4. **Idempotent writes.** `Stream` via `upsert`; `StreamEvent` via
   `@@unique([transactionHash, eventType])` + per-event `upsert` (never blind
   `createMany`). Replays are safe by construction.
5. **Dead-letter queue for poison events.** `IndexerDeadLetterEvent` captures
   undecodable/failing events with ledger, cursor, raw payload, and error;
   the worker logs, persists the dead letter, **skips** the event, and
   continues the batch. Operators replay via `POST /v1/admin/indexer/replay`.
6. **Wire-format pinning.** Contract event field names/types are pinned by
   `test_*_emits_event` (Rust) + `events-wire-format.test.ts` (backend
   `decodeMap` mirror). Renames require paired decoder updates.

## Consequences

Positive:

- At-least-once delivery with exactly-once DB effects; restarts/replays are safe.
- One poison event cannot halt indexing; dead letters give auditors a paper trail.
- SSE consumers see ordered, deduplicated lifecycle transitions.

Negative / residual:

- `StreamEvent` uniqueness on `(transactionHash, eventType)` collapses two
  same-type events in one tx (accepted: contract emits at most one
  lifecycle event per type per tx).
- Additive `Stream` mutations (`withdrawnAmount`) are last-writer-wins under
  the dual-indexer race until #801 consolidation lands — hence the freeze on
  the legacy indexer.
- Dead letters need operator triage; unmonitored growth hides upstream ABI drift.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Offset pagination on ledger sequence | Misses multi-page ledgers; breaks on RPC cursor semantics |
| `createMany(skipDuplicates)` for events | Hides which rows collided; per-event upsert preserves error context |
| Halt-on-error for poison events | One bad event freezes all indexing; violates liveness SLO |
| Dual active indexers for redundancy | Causes write races on same rows; single owner + replay is simpler and correct |
