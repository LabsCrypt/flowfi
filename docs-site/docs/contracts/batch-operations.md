---
title: Batch operations
---

# Batch operations

`batch_withdraw(stream_ids, recipient)` withdraws up to
[`MAX_BATCH_WITHDRAW`](https://github.com/LabsCrypt/flowfi/blob/main/contracts/stream_contract/src/types.rs)
(30) streams in one transaction — one signature, one fee, N payouts.

```mermaid
sequenceDiagram
    participant R as Recipient
    participant S as stream_contract
    participant T as Token

    R->>S: batch_withdraw([1, 2, 3], recipient)
    loop each stream
        S->>S: calculate_claimable(stream, now)
        S->>S: persist state (CEI)
    end
    S->>T: transfer(total, recipient)
    S-->>R: tokens_withdrawn (per stream)
```

## Semantics

- The **first failure aborts the whole batch** — partial withdrawals do not
  happen; Soroban rolls the transaction back.
- Each stream is validated (active, recipient-owned) before its accrual is
  added, so a paused or cancelled id fails loudly instead of silently
  withdrawing zero.
- Per-stream `tokens_withdrawn` events keep indexers simple: the batch is
  just N normal withdrawals sharing one transaction.
