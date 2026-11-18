# ADR 0001: Soroban Storage TTL Bump Strategy

- Status: Accepted
- Date: 2026-09-25
- Deciders: FlowFi core (contracts + backend)
- Related: `contracts/stream_contract/src/storage.rs`, `close_stream` (#1441)

## Context

Soroban charges storage rent per persistent entry and evicts entries whose TTL
expires. FlowFi stores one persistent entry per stream
(`DataKey::Stream(id)`) plus singleton instance entries
(`StreamCounter`, `ProtocolConfig`). Without TTL management:

1. Active streams risk eviction mid-lifecycle, bricking withdrawals.
2. Finished streams (`Completed` / `Cancelled`, zero balance) linger forever,
   bloating state and wasting keeper gas on pointless TTL bumps.

Ledger TTL knobs are coarse: `extend_ttl(threshold, bump_amount)` only extends
when remaining ledgers fall below `threshold`.

## Decision

Use explicit, centralized TTL constants in `storage.rs`:

- `PERSISTENT_LIFETIME_THRESHOLD = 120_960` ledgers (~7 days at 5s/ledger).
- `PERSISTENT_BUMP_AMOUNT = 518_400` ledgers (~30 days).
- `INSTANCE_LIFETIME_THRESHOLD / INSTANCE_BUMP_AMOUNT`: same values for
  instance storage.

Rules:

1. **Every read/write path bumps TTL** (`load_stream`, `save_stream`,
   `try_load_stream`, `next_stream_id`, config accessors) so hot streams never
   approach eviction during normal use.
2. **No background keeper sweeps finished streams.** `extend_stream_ttl` is an
   explicit, permissionless no-op entrypoint for keepers/UIs to bump a single
   stream on demand.
3. **Settled streams are pruned, not bumped.** `close_stream` (issue #1441)
   `remove()`s the persistent entry once a stream is terminal
   (`Completed`/`Cancelled`) with zero balance, emitting `StreamClosed` for the
   indexer to archive. This is the only state-deleting entrypoint.
4. Keep key construction centralized behind `DataKey` so TTL policy has a
   single source of truth.

## Consequences

Positive:

- Active streams survive without a dedicated keeper cron; TTL rides on normal
  traffic plus on-demand bumps.
- State bloat is bounded: pruning reclaims rent and keeps RPC footprint scans
  small.
- Auditors get a single file (`storage.rs`) to review for rent/eviction risk.

Negative / residual:

- A stream untouched for > ~37 days (threshold + bump) without any
  read/write/bump still expires; clients must call `extend_stream_ttl` for
  very long, idle streams (documented in the SDK + frontend).
- `close_stream` requires someone (sender/recipient/admin) to pay the close
  transaction fee; dust streams may never be pruned without an incentive
  (accepted: pruning is permissionless so anyone can sponsor it).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keeper cron bumping every stream | O(n) gas, bumps dead streams, centralizes liveness on backend key |
| Short TTLs + aggressive auto-extend on every ledger | Higher write costs, no pruning story |
| Archiving to instance storage instead of `remove()` | Still pays rent; `remove()` + indexer archive row is cheaper and queryable |
