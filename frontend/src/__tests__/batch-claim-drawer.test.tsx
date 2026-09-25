import { describe, expect, it } from "vitest";

function claimable(deposited: number, withdrawn: number, ratePerSecond: number, elapsed: number, active = true) {
  return active ? Math.min(Math.max(0, deposited - withdrawn), elapsed * ratePerSecond) : 0;
}

describe("batch claim selection math", () => {
  it("caps accrued balance at the deposited remainder", () => { expect(claimable(10, 4, 1, 20)).toBe(6); });
  it("excludes inactive streams", () => { expect(claimable(10, 0, 1, 20, false)).toBe(0); });
});