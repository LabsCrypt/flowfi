---
title: Recipe — DAO payroll
---

# Recipe: DAO payroll on FlowFi

Stream monthly salaries instead of batch-paying them. Contributors accrue
tokens by the second and withdraw when they choose — no claim windows.

## Pattern

1. **Treasury streams** — for each contributor, the DAO treasury creates a
   30-day linear stream funded from the payroll wallet:
   ```ts
   await client.createStream({
     sender: treasuryKeypair,
     recipient: contributor,
     token: DAO_TOKEN,
     amountStroops: monthlySalaryStroops,
     durationSeconds: 2_592_000,
   });
   ```
2. **Top up on schedule** — a cron job (GitHub Action works) tops up active
   streams before they drain; `top_up_stream` extends the runway at the same
   rate.
3. **Revocation** — for offboarded contributors, `cancel_stream` refunds the
   unaccrued remainder to the treasury automatically; the contributor keeps
   everything accrued up to cancellation.
4. **Reporting** — the treasury dashboard reads
   [`/analytics/tvl`](/backend/analytics) for total payroll committed
   and per-token velocity.

## Why streams beat batch payments

- Contributors gain cash-flow control (withdraw daily if they want).
- The DAO keeps custody until accrual — a cancelled contract returns unused
  funds with no manual reconciliation.
- Every payout is an on-chain proof, so accounting exports
  ([`/api/v1/...` export](/backend/overview)) stay trivial.
