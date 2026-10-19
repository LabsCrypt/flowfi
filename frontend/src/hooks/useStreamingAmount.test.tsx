import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStreamingAmount } from "./useStreamingAmount";

// A stable, "large" fake clock so relative offsets read as whole seconds.
const BASE_SECONDS = 1_000_000;
const BASE_MS = BASE_SECONDS * 1000;

interface HookParams {
  deposited: number;
  withdrawn: number;
  ratePerSecond: number;
  startTime?: number;
  lastUpdateTime?: number;
  isActive: boolean;
  isPaused?: boolean;
  pausedAt?: number | null;
  totalPausedDuration?: number;
}

let nowMs = BASE_MS;

describe("useStreamingAmount", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nowMs = BASE_MS;

    // A single mutable clock shared by Date.now / performance.now so advancing
    // fake timers also advances the real "current time" the hook reads.
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    // Drive requestAnimationFrame off the fake clock so the per-frame ticker
    // advances deterministically when timers are advanced.
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      return setTimeout(() => {
        nowMs += 16;
        cb(nowMs);
      }, 16) as unknown as number;
    });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("accrues over time while the stream is active", () => {
    const params: HookParams = {
      deposited: 1000,
      withdrawn: 0,
      ratePerSecond: 1,
      startTime: BASE_SECONDS - 100,
      isActive: true,
    };

    const { result } = renderHook((props: HookParams) => useStreamingAmount(props), {
      initialProps: params,
    });

    expect(result.current).toBe(100);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(result.current).toBeGreaterThan(100);
    expect(result.current).toBeCloseTo(110, 0);
  });

  it("clamps the claimable amount to deposited - withdrawn", () => {
    const params: HookParams = {
      deposited: 1000,
      withdrawn: 900,
      ratePerSecond: 1,
      startTime: BASE_SECONDS - 1000,
      isActive: true,
    };

    const { result } = renderHook((props: HookParams) => useStreamingAmount(props), {
      initialProps: params,
    });

    // Elapsed time would accrue 1000, but only 100 remains to be claimed.
    expect(result.current).toBe(100);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(result.current).toBe(100);
  });

  it("freezes while the stream is paused", () => {
    const params: HookParams = {
      deposited: 1000,
      withdrawn: 0,
      ratePerSecond: 1,
      startTime: BASE_SECONDS - 100,
      isActive: true,
      isPaused: true,
      pausedAt: BASE_SECONDS - 50,
    };

    const { result } = renderHook((props: HookParams) => useStreamingAmount(props), {
      initialProps: params,
    });

    // 100s elapsed since start, 50s of which were spent paused.
    expect(result.current).toBe(50);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    // Still frozen at the value captured when the stream was paused.
    expect(result.current).toBe(50);
  });

  it("returns 0 when the stream is not active and has not started accruing", () => {
    const params: HookParams = {
      deposited: 1000,
      withdrawn: 0,
      ratePerSecond: 1,
      startTime: BASE_SECONDS + 100,
      isActive: false,
    };

    const { result } = renderHook((props: HookParams) => useStreamingAmount(props), {
      initialProps: params,
    });

    expect(result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    // A non-active stream does not tick at all.
    expect(result.current).toBe(0);
  });

  it("cleans up its animation frame on unmount", () => {
    const params: HookParams = {
      deposited: 1000,
      withdrawn: 0,
      ratePerSecond: 1,
      startTime: BASE_SECONDS - 100,
      isActive: true,
    };

    const { result, unmount } = renderHook(
      (props: HookParams) => useStreamingAmount(props),
      { initialProps: params },
    );

    expect(result.current).toBe(100);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();
    // No ticker remains scheduled after unmount.
    expect(vi.getTimerCount()).toBe(0);
  });
});
