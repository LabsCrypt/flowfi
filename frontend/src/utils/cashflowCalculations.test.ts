import { describe, expect, it } from "vitest";
import { estimateRunwayDate, projectCashflow } from "./cashflowCalculations";

describe("cashflow calculations", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  it("does not accrue paused streams", () => { const result = projectCashflow([{ id: "1", direction: "incoming", token: "USDC", deposited: 100, withdrawn: 0, ratePerSecond: 1, isActive: true, isPaused: true }], 1, now); expect(result[1]?.projected).toBe(0); });
  it("projects active flow in daily intervals", () => { const result = projectCashflow([{ id: "1", direction: "incoming", token: "USDC", deposited: 1000, withdrawn: 0, ratePerSecond: 0.001, isActive: true }], 1, now); expect(result[1]?.projected).toBeCloseTo(86.4); });
  it("estimates outgoing runway from remaining balance", () => { expect(estimateRunwayDate([{ id: "1", direction: "outgoing", token: "USDC", deposited: 100, withdrawn: 0, ratePerSecond: 1 / 86400, isActive: true }], now)?.toISOString()).toBe("2026-04-11T00:00:00.000Z"); });

  it("limits a one-day-funded incoming stream over 90 days and stops flow after depletion", () => {
    const stream = {
      id: "stream-1day",
      direction: "incoming" as const,
      token: "USDC",
      deposited: 86400,
      withdrawn: 0,
      ratePerSecond: 1,
      isActive: true,
    };
    const result = projectCashflow([stream], 90, now);

    expect(result).toHaveLength(91);
    expect(result[0]!.projected).toBe(0);
    expect(result[1]!.projected).toBe(86400);
    expect(result[1]!.dailyRate).toBe(86400);

    // Day 2 and 3 should stop accruing and have 0 dailyRate
    expect(result[2]!.projected).toBe(86400);
    expect(result[2]!.dailyRate).toBe(0);
    expect(result[3]!.projected).toBe(86400);
    expect(result[3]!.dailyRate).toBe(0);

    // By day 90, it remains capped at 86400
    expect(result[90]!.projected).toBe(86400);
    expect(result[90]!.dailyRate).toBe(0);
  });

  it("projects mixed streams that deplete on different days, including a partial final day", () => {
    const streams = [
      // Depletes after exactly 1 day (86400 units)
      {
        id: "s1",
        direction: "incoming" as const,
        token: "USDC",
        deposited: 86400,
        withdrawn: 0,
        ratePerSecond: 1,
        isActive: true,
      },
      // Depletes after 1.5 days (86400 on day 1, 43200 partial on day 2)
      {
        id: "s2",
        direction: "incoming" as const,
        token: "USDC",
        deposited: 129600,
        withdrawn: 0,
        ratePerSecond: 1,
        isActive: true,
      },
      // Depletes after 3 days (86400 * 3)
      {
        id: "s3",
        direction: "incoming" as const,
        token: "USDC",
        deposited: 259200,
        withdrawn: 0,
        ratePerSecond: 1,
        isActive: true,
      },
    ];

    const result = projectCashflow(streams, 5, now);

    // Day 0: starting point
    expect(result[0]!.projected).toBe(0);

    // Day 1: all 3 streams flow full day -> 86400 * 3 = 259200
    expect(result[1]!.dailyRate).toBe(259200);
    expect(result[1]!.projected).toBe(259200);

    // Day 2: s1 is depleted (0), s2 flows remaining 43200 (partial), s3 flows 86400 -> total 129600
    expect(result[2]!.dailyRate).toBe(129600);
    expect(result[2]!.projected).toBe(259200 + 129600);

    // Day 3: s1 and s2 are depleted, s3 flows last 86400 -> total 86400
    expect(result[3]!.dailyRate).toBe(86400);
    expect(result[3]!.projected).toBe(259200 + 129600 + 86400);

    // Day 4 & 5: all depleted -> dailyRate 0, projected flat
    expect(result[4]!.dailyRate).toBe(0);
    expect(result[4]!.projected).toBe(475200);
    expect(result[5]!.dailyRate).toBe(0);
    expect(result[5]!.projected).toBe(475200);
  });

  it("limits outgoing streams to their unvested remaining deposit", () => {
    const stream = {
      id: "out-1",
      direction: "outgoing" as const,
      token: "USDC",
      deposited: 100000,
      withdrawn: 13600, // remaining = 86400
      ratePerSecond: 1,
      isActive: true,
    };
    const result = projectCashflow([stream], 3, now);

    expect(result[0]!.balance).toBe(86400);
    expect(result[1]!.balance).toBe(0);
    expect(result[1]!.dailyRate).toBe(-86400);
    expect(result[2]!.balance).toBe(0);
    expect(result[2]!.dailyRate).toBe(0);
  });
});