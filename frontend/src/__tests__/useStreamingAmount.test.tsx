import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStreamingAmount } from "../hooks/useStreamingAmount";

describe("useStreamingAmount", () => {
  let mockTimeMs = 1000 * 1000 * 1000; // t = 1,000,000s in ms

  beforeEach(() => {
    vi.useFakeTimers();
    mockTimeMs = 1000 * 1000 * 1000;
    
    // Mock performance.now and Date.now to return our simulated clock
    vi.spyOn(performance, "now").mockImplementation(() => mockTimeMs);
    vi.spyOn(Date, "now").mockImplementation(() => mockTimeMs);

    // Mock requestAnimationFrame and cancelAnimationFrame to run under fake timers
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      return setTimeout(() => {
        mockTimeMs += 16;
        cb(mockTimeMs);
      }, 16) as unknown as number;
    });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
      clearTimeout(id as unknown as NodeJS.Timeout);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("accurately streams amount, caps at deposited - withdrawn, and drops to 0 after withdraw update", () => {
    const params = {
      deposited: 1000,
      withdrawn: 0,
      ratePerSecond: 1,
      startTime: 1000 * 1000 - 100, // started 100 seconds ago (at t = 999,900s)
      isActive: true,
    };

    const { result, rerender } = renderHook(
      (props) => useStreamingAmount(props),
      { initialProps: params }
    );

    // Initial claimable (elapsed = 1,000,000 - 999,900 = 100s, rate = 1/sec)
    expect(result.current).toBe(100);

    // Advance time by 10 seconds (now at t = 1,000,010s)
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    // Claimable should accrue 10 more to 110 (with minor tolerance for 16ms ticks)
    expect(result.current).toBeCloseTo(110, 1);

    // Simulate withdraw (optimistic update):
    // withdrawn is bumped to 110 (pre-withdrawn + claimable)
    // lastUpdateTime is bumped to current time (1,000,010s)
    // startTime is removed/omitted to anchor on lastUpdateTime
    const updatedParams = {
      deposited: 1000,
      withdrawn: 110,
      ratePerSecond: 1,
      lastUpdateTime: 1000 * 1000 + 10,
      isActive: true,
    };

    rerender(updatedParams);

    // Claimable must drop to 0 immediately (does not regress/jump back up)
    expect(result.current).toBe(0);

    // Advance time by 5 seconds (now at t = 1,000,015s)
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // Claimable should accrue from 0 since lastUpdateTime (elapsed = 1,000,015 - 1,000,010 = 5s, rate = 1/sec)
    expect(result.current).toBeCloseTo(5, 1);

    // Advance time past the remaining cap (cap = 1000 - 110 = 890)
    act(() => {
      vi.advanceTimersByTime(1000 * 1000);
    });
    // Claimable must be capped at 890
    expect(result.current).toBe(890);
  });
});
