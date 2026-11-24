---
title: Recipe — SaaS subscription billing
---

# Recipe: SaaS subscription billing

Recurring billing without card rails: customers stream XLM to the merchant
while their subscription is active.

## Pattern

1. **Subscribe** — the customer opens a 30-day linear stream to the
   merchant's address at the monthly rate. The merchant backend watches
   `stream_created` events via [webhooks](/backend/webhooks) to
   activate the account.
2. **Active check** — account stays active while
   `get_projected_end_time > now + grace_period`. Expose this as a
   webhook-driven status field instead of polling chain state per request.
3. **Renewal** — before drain, the customer (or the merchant's dApp) tops up
   the existing stream with `top_up_stream`; no new contract, no new stream
   id, history preserved.
4. **Dunning** — when the projected end time passes, the webhook fires a
   `stream_completed` delivery and the account drops to grace/suspended.
5. **Cancellation** — the customer calls `cancel_stream` themselves and
   receives the unaccrued remainder — a refund with zero merchant
   intervention.

## Rate math

```text
monthly_price_stroops / 2_592_000 = rate_per_second
```

Stream at a rate you can audit on-chain; the displayed "monthly price" is
just `rate × 30d`.
