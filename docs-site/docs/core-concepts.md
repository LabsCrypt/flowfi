---
title: Core concepts
---

# Core concepts

## Streams

A **stream** is an escrowed payment that unlocks over time. The contract
records sender, recipient, token, deposited amount, withdrawn amount, and an
unlock curve. Three curves ship today:

| Curve | Releases | Typical use |
|---|---|---|
| `Linear` | `rate_per_second` continuously | Salaries, subscriptions |
| `StepTranches` | lump sums at absolute timestamps | Grants with payout dates |
| `HybridCliffLinear` | cliff lump sum + linear tail | Vesting with a lock-up |

## Claimable vs withdrawn

`claimable = unlocked(schedule, now) − withdrawn`. Withdrawal transfers the
claimable amount and never reverts funds that already accrued. Pausing freezes
accrual at `paused_at`.

## Conditional streams (#1482)

`create_conditional_stream` escrows funds against `ConditionalMilestone`
tranches whose `UnlockCondition` is a time gate, an oracle price target, or a
signed oracle attestation. Nothing unlocks by time alone: a condition must be
verified via `verify_and_unlock_milestone`, which promotes the tranche into
the normal step-unlock flow.

## Protocol guards

- **Fee circuit breaker** — `set_protocol_pause` (admin + guardian) halts
  stream creation and withdrawal protocol-wide.
- **Emergency guardian** — a second key that can pause if the admin key is
  compromised.
- **Storage TTLs** — persistent entries are bumped on access so live streams
  never expire; see [storage & TTLs](/contracts/storage-ttl).
