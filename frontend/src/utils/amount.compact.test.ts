import { describe, it, expect } from "vitest";
import { formatTokenCompact } from "./amount";

describe("formatTokenCompact", () => {
  it("formats values under 10_000 with grouping but no compact suffix", () => {
    expect(formatTokenCompact(9_999n * 10n ** 7n, 7).compact).toBe("9,999");
    expect(formatTokenCompact(1_000n * 10n ** 7n, 7).compact).toBe("1,000");
  });

  it("formats thousands with K suffix", () => {
    expect(formatTokenCompact(12_500n * 10n ** 7n, 7).compact).toBe("12.5K");
    expect(formatTokenCompact(100_000n * 10n ** 7n, 7).compact).toBe("100K");
  });

  it("formats millions with M suffix, two decimals max", () => {
    // The issue's own example: 1,450,293.4910293 USDC → "1.45M"
    const amount = 14_502_934_910_293n; // 1_450_293.4910293 at 7 decimals
    const r = formatTokenCompact(amount, 7);
    expect(r.compact).toBe("1.45M");
    expect(r.exact).toBe("1450293.4910293");
  });

  it("formats billions with B suffix", () => {
    expect(formatTokenCompact(2_500_000_000n * 10n ** 7n, 7).compact).toBe("2.5B");
  });

  it("returns '0' for zero, in both forms", () => {
    const r = formatTokenCompact(0n, 7);
    expect(r.compact).toBe("0");
    expect(r.exact).toBe("0");
  });

  it("preserves sub-cent precision in the exact form", () => {
    const r = formatTokenCompact(1n, 7); // 0.0000001
    expect(r.exact).toBe("0.0000001");
    // Compact form of 0.0000001 rounds to "0" — that's fine, the exact string is the point.
  });

  it("preserves sign in both forms", () => {
    const r = formatTokenCompact(-14_502_934_910_293n, 7);
    expect(r.compact).toBe("-1.45M");
    expect(r.exact).toBe("-1450293.4910293");
  });

  it("trims trailing zeros from the exact form", () => {
    // 100.5000000 → "100.5" not "100.5000000"
    expect(formatTokenCompact(1_005_000_000n, 7).exact).toBe("100.5");
    // 100.0000000 → "100"
    expect(formatTokenCompact(1_000_000_000n, 7).exact).toBe("100");
  });

  it("handles 0-decimal tokens", () => {
    expect(formatTokenCompact(15_000n, 0).compact).toBe("15K");
    expect(formatTokenCompact(15_000n, 0).exact).toBe("15000");
  });
});