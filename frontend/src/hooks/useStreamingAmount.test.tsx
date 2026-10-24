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

  // ─── #1781: pause / resume transitions ──────────────────────────────────
  describe("pause and resume transitions", () => {
    const baseParams: HookParams = {
      deposited: 1000,
      withdrawn: 0,
      ratePerSecond: 1,
      startTime: BASE_SECONDS - 100,
      isActive: true,
    };

    it("freezes at pausedAt and resumes from the frozen value without a jump", () => {
      const { result, rerender } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        { initialProps: baseParams },
      );

      expect(result.current).toBe(100);

      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(result.current).toBeCloseTo(110, 5);

      // Parent pauses the stream at the current wall-clock second.
      const pausedAt = nowMs / 1000;
      rerender({ ...baseParams, isPaused: true, pausedAt });
      expect(result.current).toBeCloseTo(110, 5);

      // The wall clock keeps moving while paused, but no frames run because
      // the animation loop is torn down for the paused state.
      nowMs += 30_000;
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(result.current).toBeCloseTo(110, 5);

      // Resume: the parent reports the 30s pause so the elapsed-time anchor
      // excludes it. The displayed amount continues from 110, not 140.
      rerender({
        ...baseParams,
        isPaused: false,
        pausedAt,
        totalPausedDuration: 30,
      });
      expect(result.current).toBeCloseTo(110, 5);

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(result.current).toBeCloseTo(115, 1);
    });

    it("does not double-count a pause when resuming from lastUpdateTime", () => {
      // No startTime: the hook anchors on lastUpdateTime. On resume the parent
      // advances lastUpdateTime to the resume instant, so accrual restarts
      // from zero instead of subtracting the pause twice.
      const pausedParams: HookParams = {
        deposited: 1000,
        withdrawn: 0,
        ratePerSecond: 1,
        lastUpdateTime: BASE_SECONDS - 20,
        isActive: true,
        isPaused: true,
        pausedAt: BASE_SECONDS - 5,
        totalPausedDuration: 0,
      };

      const { result, rerender } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        { initialProps: pausedParams },
      );

      // 20s elapsed since the last update, 5s of which are paused.
      expect(result.current).toBe(15);

      rerender({
        ...pausedParams,
        isPaused: false,
        pausedAt: null,
        lastUpdateTime: BASE_SECONDS,
        totalPausedDuration: 5,
      });

      // Resuming re-anchors at the resume instant.
      expect(result.current).toBe(0);

      act(() => {
        vi.advanceTimersByTime(4_000);
      });
      expect(result.current).toBeCloseTo(4, 5);
    });

    it("stops the animation loop when the stream becomes inactive mid-accrual", () => {
      const { result, rerender } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        { initialProps: baseParams },
      );

      expect(result.current).toBe(100);

      rerender({ ...baseParams, isActive: false });
      // The displayed value is frozen at the last wall-clock computation.
      expect(result.current).toBe(100);

      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(result.current).toBe(100);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // ─── #1781: clock drift and timer behavior ──────────────────────────────
  describe("clock drift and timer behavior", () => {
    it("accrues the full elapsed delta when a frame arrives late", () => {
      // Drive rAF manually so a single frame can represent a long throttled
      // gap (background tab), instead of a 16ms animation frame.
      const pendingFrames: FrameRequestCallback[] = [];
      vi.mocked(globalThis.requestAnimationFrame).mockImplementation((cb) => {
        pendingFrames.push(cb);
        return pendingFrames.length;
      });
      vi.mocked(globalThis.cancelAnimationFrame).mockImplementation(() => {
        pendingFrames.length = 0;
      });

      const { result } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        {
          initialProps: {
            deposited: 1000,
            withdrawn: 0,
            ratePerSecond: 1,
            startTime: BASE_SECONDS - 100,
            isActive: true,
          },
        },
      );

      expect(result.current).toBe(100);

      nowMs += 5_000;
      const lateFrame = pendingFrames.shift();
      act(() => {
        lateFrame?.(nowMs);
      });

      // The ticker uses the delta between frames, not a fixed increment, so
      // the 5s gap is fully reflected instead of drifting behind wall time.
      expect(result.current).toBeCloseTo(105, 5);
    });

    it("stops scheduling frames once the claimable cap is reached", () => {
      const { result } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        {
          initialProps: {
            deposited: 100,
            withdrawn: 0,
            ratePerSecond: 1,
            startTime: BASE_SECONDS - 100,
            isActive: true,
          },
        },
      );

      expect(result.current).toBe(100);

      // One final frame runs, finds the cap reached, and stops rescheduling.
      act(() => {
        vi.advanceTimersByTime(1_000);
      });

      expect(result.current).toBe(100);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("clamps to zero when the wall clock jumps backwards", () => {
      const { result } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        {
          initialProps: {
            deposited: 1000,
            withdrawn: 0,
            ratePerSecond: 1,
            startTime: BASE_SECONDS - 100,
            isActive: true,
          },
        },
      );

      expect(result.current).toBe(100);

      // Simulate a clock correction that puts "now" before the stream start.
      nowMs = BASE_MS - 500_000;
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      expect(result.current).toBe(0);
    });

    it("resyncs to wall-clock elapsed time after a hidden period", () => {
      const { result } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        {
          initialProps: {
            deposited: 1000,
            withdrawn: 0,
            ratePerSecond: 1,
            startTime: BASE_SECONDS - 100,
            isActive: true,
          },
        },
      );

      expect(result.current).toBe(100);

      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => true,
      });

      // Wall clock advances 20s while the tab is hidden; frames are throttled
      // and must not advance the displayed value.
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(result.current).toBe(100);

      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => false,
      });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      expect(result.current).toBeCloseTo(120, 5);
    });
  });

  // ─── #1781: boundary values and failure paths ───────────────────────────
  describe("boundary values and failure paths", () => {
    it.each([
      { name: "zero rate", overrides: { ratePerSecond: 0 } },
      { name: "negative rate", overrides: { ratePerSecond: -1 } },
      { name: "zero deposit", overrides: { deposited: 0 } },
      { name: "fully withdrawn", overrides: { withdrawn: 1000 } },
      { name: "over-withdrawn", overrides: { withdrawn: 1500 } },
    ])("returns 0 and schedules no frames for a $name", ({ overrides }) => {
      const { result } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        {
          initialProps: {
            deposited: 1000,
            withdrawn: 0,
            ratePerSecond: 1,
            startTime: BASE_SECONDS - 100,
            isActive: true,
            ...overrides,
          },
        },
      );

      expect(result.current).toBe(0);
      expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("returns 0 for a non-finite rate instead of leaking NaN", () => {
      const { result } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        {
          initialProps: {
            deposited: 1000,
            withdrawn: 0,
            ratePerSecond: Number.NaN,
            startTime: BASE_SECONDS - 100,
            isActive: true,
          },
        },
      );

      expect(result.current).toBe(0);
      expect(Number.isNaN(result.current)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("anchors on mount time when neither startTime nor lastUpdateTime is known", () => {
      const { result } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        {
          initialProps: {
            deposited: 1000,
            withdrawn: 0,
            ratePerSecond: 1,
            isActive: true,
          },
        },
      );

      expect(result.current).toBe(0);

      act(() => {
        vi.advanceTimersByTime(3_000);
      });
      expect(result.current).toBeCloseTo(3, 1);
    });

    it("anchors on lastUpdateTime when startTime is absent", () => {
      const { result } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        {
          initialProps: {
            deposited: 1000,
            withdrawn: 0,
            ratePerSecond: 2,
            lastUpdateTime: BASE_SECONDS - 25,
            isActive: true,
          },
        },
      );

      expect(result.current).toBe(50);
    });

    it("clamps to zero when totalPausedDuration exceeds elapsed time", () => {
      const { result } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        {
          initialProps: {
            deposited: 1000,
            withdrawn: 0,
            ratePerSecond: 1,
            startTime: BASE_SECONDS - 10,
            isActive: true,
            totalPausedDuration: 99,
          },
        },
      );

      expect(result.current).toBe(0);
    });

    it("clamps a future startTime to zero", () => {
      const { result } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        {
          initialProps: {
            deposited: 1000,
            withdrawn: 0,
            ratePerSecond: 1,
            startTime: BASE_SECONDS + 100,
            isActive: true,
          },
        },
      );

      expect(result.current).toBe(0);
    });
  });

  // ─── #1781: cleanup of timers and subscriptions ─────────────────────────
  describe("cleanup", () => {
    const activeParams: HookParams = {
      deposited: 1000,
      withdrawn: 0,
      ratePerSecond: 1,
      startTime: BASE_SECONDS - 100,
      isActive: true,
    };

    it("removes the visibilitychange subscription on unmount", () => {
      const addSpy = vi.spyOn(document, "addEventListener");
      const removeSpy = vi.spyOn(document, "removeEventListener");

      const { unmount } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        { initialProps: activeParams },
      );

      expect(
        addSpy.mock.calls.filter(([type]) => type === "visibilitychange"),
      ).toHaveLength(1);

      unmount();

      expect(
        removeSpy.mock.calls.filter(([type]) => type === "visibilitychange"),
      ).toHaveLength(1);
      expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not tick or resync after unmount", () => {
      const { result, unmount } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        { initialProps: activeParams },
      );

      const valueAtUnmount = result.current;
      unmount();

      nowMs += 60_000;
      act(() => {
        vi.advanceTimersByTime(60_000);
        document.dispatchEvent(new Event("visibilitychange"));
      });

      expect(result.current).toBe(valueAtUnmount);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("computes once without an animation loop under prefers-reduced-motion", () => {
      const matchMedia = vi
        .spyOn(window, "matchMedia")
        .mockImplementation(
          (query: string) =>
            ({
              matches: query === "(prefers-reduced-motion: reduce)",
              media: query,
              onchange: null,
              addListener: vi.fn(),
              removeListener: vi.fn(),
              addEventListener: vi.fn(),
              removeEventListener: vi.fn(),
              dispatchEvent: vi.fn(),
            }) as unknown as MediaQueryList,
        );

      const { result, unmount } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        { initialProps: activeParams },
      );

      expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
      expect(result.current).toBe(100);
      expect(globalThis.requestAnimationFrame).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
