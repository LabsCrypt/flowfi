---
title: Storage & TTLs
---

# Storage & TTLs

Soroban ledger entries expire without footprints. The contract therefore
classifies every entry:

| Entry | Class | Policy |
|---|---|---|
| `ProtocolConfig`, `ContractVersion`, `ContractWasmHash`, counters | instance | Bumped on every protocol write |
| `Stream(id)` | persistent | Bumped on every read *and* write of the stream |
| `ConditionalMilestones(id)`, `AttestedIds(id)` (#1482) | instance | Written at creation/verification |

## Why streams bump on read

`get_claimable_amount` extends the stream entry's TTL as a side effect: a
dashboard polling an idle-but-live stream keeps it alive. An *unaccessed*
stream still expires — by design, Soroban state is rent-paid, and a stream
nobody queries or withdraws from is dead weight.

## Recovery

Expired streams are recoverable by re-creating the entry from chain events
(the indexer does exactly this; see
[event ingestion](/backend/event-ingestion)). Amounts are recomputed
deterministically from `start_time`, the schedule, and `withdrawn_amount`.
