/**
 * Spending analytics for the recurring-subscription dashboard (issue #1327).
 *
 * UI-free so the burn-rate / allowance math can be unit-tested and reused by
 * both the subscriber view and the merchant (MRR) view. All token amounts are
 * raw on-chain integers (smallest unit) as `bigint`.
 */

export interface Subscription {
  id: string;
  /** Service / merchant being paid continuously. */
  merchant: string;
  /** Recurring charge per 30-day month, smallest unit. */
  monthlyAmount: bigint;
  tokenSymbol: string;
  /** Approved allowance still available to the merchant, smallest unit. */
  allowanceRemaining: bigint;
  /** Allowance originally approved, smallest unit. */
  allowanceTotal: bigint;
  active: boolean;
}

/** Sum of the monthly charge across every active subscription. */
export function totalMonthlyBurn(subscriptions: Subscription[]): bigint {
  return subscriptions.reduce(
    (sum, sub) => (sub.active ? sum + sub.monthlyAmount : sum),
    0n,
  );
}

/**
 * Remaining approved allowance as a percentage (0–100), for the allowance
 * meter. Returns 0 when nothing was approved, and clamps to [0, 100] so a
 * top-up that exceeds the original total still renders a full bar.
 */
export function allowanceRemainingPercent(sub: Subscription): number {
  if (sub.allowanceTotal <= 0n) return 0;
  const raw = Number((sub.allowanceRemaining * 10_000n) / sub.allowanceTotal) / 100;
  return Math.max(0, Math.min(100, raw));
}

/**
 * Whole months of runway left before the approved allowance is exhausted at
 * the current monthly rate. `Infinity` for a paused/zero-rate subscription.
 */
export function monthsOfRunway(sub: Subscription): number {
  if (sub.monthlyAmount <= 0n) return Infinity;
  return Number(sub.allowanceRemaining / sub.monthlyAmount);
}

/** A subscription whose allowance cannot cover even one more month. */
export function isRunningLow(sub: Subscription): boolean {
  return sub.active && sub.allowanceRemaining < sub.monthlyAmount;
}

export interface MerchantMrr {
  merchant: string;
  activeSubscribers: number;
  /** Expected monthly recurring revenue, smallest unit. */
  mrr: bigint;
}

/** Aggregate a subscriber-side list into per-merchant MRR for the merchant tab. */
export function merchantMrrBreakdown(subscriptions: Subscription[]): MerchantMrr[] {
  const byMerchant = new Map<string, MerchantMrr>();
  for (const sub of subscriptions) {
    if (!sub.active) continue;
    const entry = byMerchant.get(sub.merchant) ?? {
      merchant: sub.merchant,
      activeSubscribers: 0,
      mrr: 0n,
    };
    entry.activeSubscribers += 1;
    entry.mrr += sub.monthlyAmount;
    byMerchant.set(sub.merchant, entry);
  }
  return [...byMerchant.values()].sort((a, b) =>
    a.merchant.localeCompare(b.merchant),
  );
}
