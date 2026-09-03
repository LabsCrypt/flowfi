import { describe, it, expect } from "vitest";
import {
  totalMonthlyBurn,
  allowanceRemainingPercent,
  monthsOfRunway,
  isRunningLow,
  merchantMrrBreakdown,
  type Subscription,
} from "./subscriptions";

function makeSub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub",
    merchant: "Acme",
    monthlyAmount: 10_000_000n,
    tokenSymbol: "USDC",
    allowanceRemaining: 30_000_000n,
    allowanceTotal: 60_000_000n,
    active: true,
    ...overrides,
  };
}

describe("totalMonthlyBurn", () => {
  it("sums only active subscriptions", () => {
    const subs = [
      makeSub({ monthlyAmount: 10n }),
      makeSub({ monthlyAmount: 25n }),
      makeSub({ monthlyAmount: 100n, active: false }),
    ];
    expect(totalMonthlyBurn(subs)).toBe(35n);
  });

  it("is 0n for an empty list", () => {
    expect(totalMonthlyBurn([])).toBe(0n);
  });
});

describe("allowanceRemainingPercent", () => {
  it("computes the remaining fraction", () => {
    expect(allowanceRemainingPercent(makeSub())).toBe(50);
  });

  it("returns 0 when nothing was approved", () => {
    expect(
      allowanceRemainingPercent(makeSub({ allowanceTotal: 0n, allowanceRemaining: 0n })),
    ).toBe(0);
  });

  it("clamps above 100 when remaining exceeds the original total", () => {
    expect(
      allowanceRemainingPercent(
        makeSub({ allowanceRemaining: 90n, allowanceTotal: 60n }),
      ),
    ).toBe(100);
  });
});

describe("monthsOfRunway / isRunningLow", () => {
  it("floors to whole months of runway", () => {
    expect(
      monthsOfRunway(makeSub({ allowanceRemaining: 25n, monthlyAmount: 10n })),
    ).toBe(2);
  });

  it("reports Infinity for a zero-rate subscription", () => {
    expect(monthsOfRunway(makeSub({ monthlyAmount: 0n }))).toBe(Infinity);
  });

  it("flags an active subscription that cannot cover one more month", () => {
    expect(
      isRunningLow(makeSub({ allowanceRemaining: 5n, monthlyAmount: 10n })),
    ).toBe(true);
    expect(
      isRunningLow(
        makeSub({ allowanceRemaining: 5n, monthlyAmount: 10n, active: false }),
      ),
    ).toBe(false);
  });
});

describe("merchantMrrBreakdown", () => {
  it("aggregates active subscribers and MRR per merchant, sorted by name", () => {
    const subs = [
      makeSub({ merchant: "Netflix", monthlyAmount: 15n }),
      makeSub({ merchant: "Netflix", monthlyAmount: 15n }),
      makeSub({ merchant: "Acme", monthlyAmount: 40n }),
      makeSub({ merchant: "Acme", monthlyAmount: 40n, active: false }),
    ];
    expect(merchantMrrBreakdown(subs)).toEqual([
      { merchant: "Acme", activeSubscribers: 1, mrr: 40n },
      { merchant: "Netflix", activeSubscribers: 2, mrr: 30n },
    ]);
  });
});
