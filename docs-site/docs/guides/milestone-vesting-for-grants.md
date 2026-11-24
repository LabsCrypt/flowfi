---
title: Recipe — Milestone vesting for grants
---

# Recipe: Milestone vesting for grants

Grant committees stop being manual approvers: escrow once, let oracles and
attestations release tranches.

## Option A — dated tranches (time-based)

Board dates are known up front? Use `create_step_vesting_stream`:

```ts
const steps = [
  { unlock_time: ts("2026-10-01"), unlock_amount: 2_000_000_000n },
  { unlock_time: ts("2026-11-01"), unlock_amount: 2_000_000_000n },
  { unlock_time: ts("2026-12-01"), unlock_amount: 2_000_000_000n },
];
await client.createStepVestingStream({ sender, recipient, token, amountStroops, steps });
```

## Option B — KPI-gated tranches (#1482)

Delivery depends on proof, not dates — price targets, protocol KPIs, audited
milestones. Use `create_conditional_stream` and let the grantee trigger
verification when the milestone lands:

```ts
await client.createConditionalStream({
  sender: treasury,
  recipient: grantee,
  token,
  amountStroops,
  milestones: [
    { milestone_id: 1, amount: 1_500_000_000n,
      condition: { PriceTarget: [oracle, 500_00000n, true] }, is_unlocked: false },
    { milestone_id: 2, amount: 1_500_000_000n,
      condition: { OracleAttestation: [auditorSigner, auditHash] }, is_unlocked: false },
  ],
});
```

The committee's job shrinks to signing attestations (or running the oracle).
Withdrawal uses the ordinary `withdraw` path — see
[conditional streams](/contracts/conditional-streams) for the guarantee
set (freshness window, single-use attestation ids, escrow-equals-schedule).
