import { describe, expect, it } from "vitest";
import { estimateRunwayDate, projectCashflow } from "./cashflowCalculations";

describe("cashflow calculations", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  it("does not accrue paused streams", () => { const result = projectCashflow([{ id: "1", direction: "incoming", token: "USDC", deposited: 100, withdrawn: 0, ratePerSecond: 1, isActive: true, isPaused: true }], 1, now); expect(result[1]?.projected).toBe(0); });
  it("projects active flow in daily intervals", () => { const result = projectCashflow([{ id: "1", direction: "incoming", token: "USDC", deposited: 1000, withdrawn: 0, ratePerSecond: 0.001, isActive: true }], 1, now); expect(result[1]?.projected).toBeCloseTo(86.4); });
  it("estimates outgoing runway from remaining balance", () => { expect(estimateRunwayDate([{ id: "1", direction: "outgoing", token: "USDC", deposited: 100, withdrawn: 0, ratePerSecond: 1 / 86400, isActive: true }], now)?.toISOString()).toBe("2026-04-11T00:00:00.000Z"); });
});