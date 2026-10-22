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

  // ─── Pause/resume transitions, clock drift, unmount (#1781) ─────────────

  describe('pause/resume transitions, drift and unmount (#1781)', () => {
    // While the stream is paused no frame loop runs, so the fake clock only
    // moves when a tick fires. Tests bump `nowMs` directly to simulate wall
    // time passing during a pause.
    const advanceWallClock = (ms: number) => {
      nowMs += ms;
      vi.advanceTimersByTime(ms);
    };

    it('starts at 0 for a stream that just began and accrues normally', () => {
      const params: HookParams = {
        deposited: 1000,
        withdrawn: 0,
        ratePerSecond: 1,
        startTime: BASE_SECONDS,
        isActive: true,
      };

      const { result } = renderHook((props: HookParams) => useStreamingAmount(props), {
        initialProps: params,
      });

      expect(result.current).toBe(0);

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(result.current).toBeCloseTo(3, 0);
    });

    it('freezes on pause and resumes from the pre-pause value', () => {
      const params: HookParams = {
        deposited: 1000,
        withdrawn: 0,
        ratePerSecond: 1,
        startTime: BASE_SECONDS - 100,
        isActive: true,
      };

      const { result, rerender } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        { initialProps: params },
      );

      expect(result.current).toBe(100);

      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(result.current).toBeCloseTo(105, 0);

      // Pause at the current wall time (the value captured at pause time).
      const pausedAt = nowMs / 1000;
      rerender({ ...params, isPaused: true, pausedAt });
      expect(result.current).toBeCloseTo(105, 0);
      // Paused: no frame loop remains scheduled.
      expect(vi.getTimerCount()).toBe(0);

      // 10 seconds pass while paused — the value must not move.
      act(() => {
        advanceWallClock(10_000);
      });
      expect(result.current).toBeCloseTo(105, 0);

      // Resume, excluding the paused window via totalPausedDuration.
      rerender({
        ...params,
        isPaused: false,
        pausedAt: null,
        totalPausedDuration: 10,
      });
      expect(result.current).toBeCloseTo(105, 0);
      // Exactly one frame loop after resume — no duplicates.
      expect(vi.getTimerCount()).toBe(1);

      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(result.current).toBeCloseTo(110, 0);
    });

    it('excludes paused time across repeated pause/resume cycles', () => {
      const params: HookParams = {
        deposited: 1000,
        withdrawn: 0,
        ratePerSecond: 1,
        startTime: BASE_SECONDS,
        isActive: true,
      };

      const { result, rerender } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        { initialProps: params },
      );

      expect(result.current).toBe(0);

      let totalPausedDuration = 0;
      let activeSeconds = 0;

      for (let cycle = 1; cycle <= 3; cycle++) {
        // Stream for 2 seconds.
        act(() => {
          vi.advanceTimersByTime(2000);
        });
        activeSeconds += 2;
        expect(result.current).toBeCloseTo(activeSeconds, 0);
        expect(vi.getTimerCount()).toBe(1);

        // Pause for 2 seconds.
        const pausedAt = Math.floor(nowMs / 1000);
        rerender({ ...params, isPaused: true, pausedAt, totalPausedDuration });
        expect(vi.getTimerCount()).toBe(0);
        const valueAtPause = result.current;

        act(() => {
          advanceWallClock(2000);
        });
        expect(result.current).toBe(valueAtPause);

        // Resume — paused time is excluded via totalPausedDuration.
        totalPausedDuration += 2;
        rerender({
          ...params,
          isPaused: false,
          pausedAt: null,
          totalPausedDuration,
        });
        expect(result.current).toBeCloseTo(activeSeconds, 0);
        expect(vi.getTimerCount()).toBe(1);
      }

      // Final 2-second burst after the last resume.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(result.current).toBeCloseTo(8, 0);
      expect(vi.getTimerCount()).toBe(1);
    });

    it('freezes at 0 when the stream was paused at its start time', () => {
      const params: HookParams = {
        deposited: 1000,
        withdrawn: 0,
        ratePerSecond: 1,
        startTime: BASE_SECONDS - 100,
        isActive: true,
        isPaused: true,
        pausedAt: BASE_SECONDS - 100,
      };

      const { result } = renderHook((props: HookParams) => useStreamingAmount(props), {
        initialProps: params,
      });

      expect(result.current).toBe(0);

      act(() => {
        advanceWallClock(10_000);
      });

      expect(result.current).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('never schedules a frame loop for zero-rate or fully-claimed streams', () => {
      const zeroRate: HookParams = {
        deposited: 1000,
        withdrawn: 0,
        ratePerSecond: 0,
        startTime: BASE_SECONDS - 100,
        isActive: true,
      };

      const { result, unmount } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        { initialProps: zeroRate },
      );

      expect(result.current).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(result.current).toBe(0);
      unmount();

      const drained: HookParams = {
        deposited: 100,
        withdrawn: 100,
        ratePerSecond: 1,
        startTime: BASE_SECONDS - 100,
        isActive: true,
      };

      const { result: drainedResult } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        { initialProps: drained },
      );

      expect(drainedResult.current).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('resyncs to the wall clock after clock drift without duplicating timers', () => {
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

      // The wall clock jumps 60s ahead (e.g. an NTP correction) while the
      // animation-frame clock keeps ticking at the same rate.
      vi.spyOn(Date, 'now').mockImplementation(() => nowMs + 60_000);

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      // Frame-driven accrual is unaffected by the wall-clock jump.
      expect(result.current).toBeCloseTo(101, 0);

      // Becoming visible again resyncs the displayed value to the true
      // elapsed time per the visibilitychange contract.
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(result.current).toBeCloseTo(161, 0);
      // Still exactly one frame loop — the resync must not add another.
      expect(vi.getTimerCount()).toBe(1);

      // Accrual continues from the corrected value.
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(result.current).toBeCloseTo(162, 0);
    });

    it('cancels timers and stops updating when unmounted mid-stream', () => {
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

      act(() => {
        vi.advanceTimersByTime(2000);
      });

      const valueAtUnmount = result.current;
      expect(valueAtUnmount).toBeGreaterThan(0);
      expect(vi.getTimerCount()).toBe(1);

      unmount();

      expect(globalThis.cancelAnimationFrame).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      // No stale ticker may keep mutating state after unmount.
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(result.current).toBe(valueAtUnmount);
    });

    it('leaves no timers behind when unmounted while paused', () => {
      const params: HookParams = {
        deposited: 1000,
        withdrawn: 0,
        ratePerSecond: 1,
        startTime: BASE_SECONDS - 100,
        isActive: true,
        isPaused: true,
        pausedAt: BASE_SECONDS - 50,
      };

      const { result, unmount } = renderHook(
        (props: HookParams) => useStreamingAmount(props),
        { initialProps: params },
      );

      expect(result.current).toBe(50);
      expect(vi.getTimerCount()).toBe(0);

      unmount();

      expect(vi.getTimerCount()).toBe(0);

      act(() => {
        advanceWallClock(60_000);
      });
      expect(result.current).toBe(50);
    });
  });
});
