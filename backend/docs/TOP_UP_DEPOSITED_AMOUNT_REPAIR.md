# Repairing Overcounted `depositedAmount` (Issue #1848)

## Background

`depositedAmount` had two independent writers applying the same top-up:

| Writer | Location | Semantics |
| --- | --- | --- |
| API handler | `backend/src/controllers/stream.controller.ts` (`topUpStreamHandler`) | relative: `depositedAmount + amount` |
| Event indexer | `backend/src/workers/soroban-event-worker.ts` (`handleStreamToppedUp`) | absolute: `new_deposited_amount` from the `StreamToppedUp` event |

The handler wrote no `TOPPED_UP` row, so the indexer's dedup key
(`@@unique([transactionHash, eventType])`) never covered it. `topUpStream` awaits
`pollTransactionStatus`, which confirms the transaction on-chain — so the indexer
could commit its absolute value first and the handler would then add the same
amount a second time. The stream ends up permanently overcounted, and `endTime` —
which both writers project as `startTime + depositedAmount / ratePerSecond +
totalPausedDuration` — drifts later by the same amount.

The fix makes the handler write inside one transaction that takes a `FOR UPDATE`
lock on the `Stream` row and records the same `TOPPED_UP` marker the indexer keys
on, so exactly one of the two writers moves `depositedAmount` in either arrival
order. This document covers the rows that were already wrong before the fix
shipped.

## What the event log can and cannot prove

`StreamEvent` is the ledger of record for deposits:

- one `CREATED` row per stream, whose `amount` is the initial deposit
  (`deposited_amount` from the on-chain `StreamCreated` event);
- one `TOPPED_UP` row per top-up transaction hash, whose `amount` is that
  top-up.

Because the contract's `new_deposited_amount` is the running sum of exactly those
events, the authoritative value for a stream is:

```
expected = CREATED.amount + Σ TOPPED_UP.amount
```

Two caveats decide when that is safe to write back:

1. **The indexer must have caught up.** A top-up whose transaction landed
   seconds ago legitimately has `depositedAmount > expected` — the handler
   applied it and the event has not been indexed yet. Re-derive only after the
   indexer has reached a ledger at or beyond that transaction.
2. **Negative deltas mean the log is incomplete, not that the row is low.** If
   the event index is missing a `TOPPED_UP` (a stream created before the event
   backfill, or a pruned row), the repair would *reduce* a correct balance.
   Never apply a downward-only shortcut; reconcile against the on-chain value
   instead (see "Escalation").

## Step 1 — Audit (read-only)

Run against a replica first. `depositedAmount` and `amount` are `text` columns
holding i128 values, so aggregate in `numeric`, not `bigint` — `bigint` overflows
above ~9.2e18, which is exactly the range an i128 token amount can reach.

```sql
WITH ledger AS (
  SELECT
    "streamId",
    SUM(
      CASE WHEN "eventType" = 'CREATED' THEN COALESCE("amount", '0')::numeric ELSE 0 END
    ) AS initial_deposit,
    SUM(
      CASE WHEN "eventType" = 'TOPPED_UP' THEN COALESCE("amount", '0')::numeric ELSE 0 END
    ) AS topped_up
  FROM "StreamEvent"
  WHERE "eventType" IN ('CREATED', 'TOPPED_UP')
  GROUP BY "streamId"
)
SELECT
  s."streamId",
  s."depositedAmount"::numeric                                AS stored,
  l.initial_deposit + l.topped_up                             AS expected,
  s."depositedAmount"::numeric - (l.initial_deposit + l.topped_up) AS drift,
  s."ratePerSecond"::numeric,
  s."endTime",
  s."isActive",
  s."isPaused",
  (SELECT MAX("ledgerSequence") FROM "StreamEvent" WHERE "streamId" = s."streamId") AS last_event_ledger
FROM "Stream" s
JOIN ledger l ON l."streamId" = s."streamId"
WHERE s."depositedAmount"::numeric <> l.initial_deposit + l.topped_up
ORDER BY abs(s."depositedAmount"::numeric - (l.initial_deposit + l.topped_up)) DESC;
```

Read the result three ways:

- `drift > 0` and the stream's `last_event_ledger` is behind the indexer's
  current position → **in-flight top-up**, not a bug. Re-check after the next
  indexer run.
- `drift > 0` with no in-flight top-up → **double-counted by this bug**.
- `drift < 0` → **the event log is incomplete**; escalate, do not write.

Compare `IndexerState.lastLedger` against each row's `last_event_ledger` before
concluding anything.

## Step 2 — Repair

Wrap the whole repair in a transaction and take the same row lock the writers
take, so a live top-up cannot interleave with it. Capture the pre-repair values
first; the audit is not reproducible once the rows are overwritten.

The script writes every row it touches into this table before and after the
change, so the run is auditable and reversible one stream at a time.

```sql
CREATE TABLE IF NOT EXISTS "TopUpRepairAudit_1848" (
  "streamId"   BIGINT       NOT NULL,
  "before"     TEXT         NOT NULL,
  "after"      TEXT         NOT NULL,
  "drift"      NUMERIC      NOT NULL,
  "repairedAt" TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

Per stream, in one transaction (repeat for every `drift > 0` row from Step 1).
`:streamId` is the only input; the script captures each result and feeds it to
the next statement, which is what makes the run reversible one stream at a time.

```sql
BEGIN;

-- 1. Take the same row lock the API handler and the indexer take, so a live
--    top-up cannot interleave with the repair. Keep the value: it becomes the
--    audit row's `before`. If this blocks, a top-up is in flight for this
--    stream - skip it and re-audit later.
SELECT "depositedAmount"
  FROM "Stream"
 WHERE "streamId" = :streamId
 FOR UPDATE;

-- 2. Re-derive from the event log and write. Guarded so it can only lower a
--    balance this bug raised, and so it no-ops if the row is already correct.
WITH ledger AS (
  SELECT COALESCE(SUM(CASE WHEN "eventType" = 'CREATED'
                           THEN COALESCE("amount", '0')::numeric END), 0)
       + COALESCE(SUM(CASE WHEN "eventType" = 'TOPPED_UP'
                           THEN COALESCE("amount", '0')::numeric END), 0) AS expected
  FROM "StreamEvent"
 WHERE "streamId" = :streamId
   AND "eventType" IN ('CREATED', 'TOPPED_UP')
)
UPDATE "Stream" s
   SET "depositedAmount" = l.expected::text,
       "endTime" = CASE
                     WHEN s."ratePerSecond"::numeric = 0 THEN s."endTime"
                     ELSE s."startTime"
                        + div(l.expected, s."ratePerSecond"::numeric)::bigint
                        + s."totalPausedDuration"::bigint
                   END
  FROM ledger l
 WHERE s."streamId" = :streamId
   AND l.expected > 0
   AND s."depositedAmount"::numeric > l.expected
RETURNING "depositedAmount";

-- 3. Record the pair. Zero rows from step 2 means nothing changed; do not write
--    an audit row for it.
INSERT INTO "TopUpRepairAudit_1848" ("streamId", "before", "after", "drift")
VALUES (:streamId, :before, :after, :before::numeric - :after::numeric);

COMMIT;
```

Three deliberate constraints:

- **`div(numeric, numeric)`, not `/` then `::bigint`.** `div` truncates toward
  zero, which is exactly the `BigInt` division in `projectedEndTime`
  (`backend/src/services/top-up-projection.ts`). Casting a `numeric` quotient to
  `bigint` *rounds*, and a one-second difference here re-creates the drift this
  repair exists to remove.
- **`AND s."depositedAmount" > l.expected` — the repair only lowers balances.**
  This bug could only raise them. A row with the opposite sign is an indexer gap
  and belongs in Escalation, not here.
- **One stream per transaction.** A single bad row rolls back one stream instead
  of the batch, and the `FOR UPDATE` hold stays short.

`endTime` is rewritten in the same statement because both writers projected it
from the overcounted value.

## Step 3 — Verify

```sql
-- 1. No positive drift remains outside the indexer-lag window.
SELECT count(*) FROM "Stream" s
JOIN (
  SELECT "streamId",
         SUM(COALESCE("amount", '0')::numeric) AS expected
  FROM "StreamEvent"
  WHERE "eventType" IN ('CREATED', 'TOPPED_UP')
  GROUP BY "streamId"
) l ON l."streamId" = s."streamId"
WHERE s."depositedAmount"::numeric > l.expected;

-- 2. `endTime` agrees with the projection for every non-zero-rate stream.
SELECT s."streamId", s."endTime",
       s."startTime" + (s."depositedAmount"::bigint / s."ratePerSecond"::bigint)
         + s."totalPausedDuration"::bigint AS projected
FROM "Stream" s
WHERE s."ratePerSecond"::numeric <> '0'
  AND s."endTime" IS DISTINCT FROM
      s."startTime" + (s."depositedAmount"::bigint / s."ratePerSecond"::bigint)
        + s."totalPausedDuration"::bigint;
```

Query 2 uses `::bigint` and so is a spot-check, not a proof, for streams whose
amounts exceed bigint range; for those, compute the projection in the script with
`BigInt` and compare in application code.

Then confirm on chain that `get_stream(streamId).deposited_amount` equals the
repaired `depositedAmount` for every row in the audit table. The chain is the
only witness the indexer's absolute write trusts, so it is the only acceptable
final check.

## Escalation: negative drift

`depositedAmount < expected` means the event log holds a top-up the row never
received, or a row is missing a `CREATED` event. Both are indexer gaps, not this
bug, and re-deriving from the log would corrupt a balance that the chain says is
right. For those streams:

1. read `deposited_amount` from the contract with `getStreamFromChain`,
2. write that value plus the projected `endTime` by hand,
3. file a separate issue — do not fold the fix into this repair.

## Timing

Run the audit read-only first and share the row count. Apply during a window
where the indexer is paused, or the set of "in-flight" false positives keeps
moving and the run is not reproducible. To pause it, stop
`soroban-event-worker`; the API is unaffected apart from stream projections
lagging. Restart it after the repair and re-run Step 3 — the absolute writes are
idempotent per event hash, so the indexer cannot reintroduce the double count
once the fix is deployed.
