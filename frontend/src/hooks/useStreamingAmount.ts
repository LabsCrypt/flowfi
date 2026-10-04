"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface UseStreamingAmountParams {
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function useStreamingAmount({
  deposited,
  withdrawn,
  ratePerSecond,
  startTime,
  lastUpdateTime,
  isActive,
  isPaused = false,
  pausedAt = null,
  totalPausedDuration = 0,
}: UseStreamingAmountParams) {
  const maxClaimable = useMemo(
    () => Math.max(deposited - withdrawn, 0),
    [deposited, withdrawn],
  );

  const [claimable, setClaimable] = useState(0);
  const claimableRef = useRef(0);

  useEffect(() => {
    let rafId: number | null = null;
    const isStreaming =
      isActive &&
      !isPaused &&
      ratePerSecond > 0 &&
      maxClaimable > 0;
    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let lastFrameTime = performance.now();

    const computeClaimable = () => {
      const nowSeconds = Date.now() / 1000;
      const streamStartTime = startTime ?? lastUpdateTime ?? nowSeconds;
      const elapsedSinceStart = Math.max(0, nowSeconds - streamStartTime);
      const currentPauseDuration =
        isPaused && pausedAt ? Math.max(0, nowSeconds - pausedAt) : 0;
      const effectiveElapsed = Math.max(
        0,
        elapsedSinceStart - (startTime ? totalPausedDuration : 0) - currentPauseDuration,
      );

      return clamp(effectiveElapsed * ratePerSecond, 0, maxClaimable);
    };

    claimableRef.current = computeClaimable();
    setClaimable(claimableRef.current);

    const tick = (frameTime: number) => {
      if (document.hidden) {
        // Skip recomputation while the tab is backgrounded; just keep
        // rescheduling so we notice when it becomes visible again.
        lastFrameTime = frameTime;
        rafId = requestAnimationFrame(tick);
        return;
      }

      const deltaSeconds = Math.max(0, (frameTime - lastFrameTime) / 1000);
      lastFrameTime = frameTime;

      const nextClaimable = isStreaming
        ? clamp(claimableRef.current + ratePerSecond * deltaSeconds, 0, maxClaimable)
        : 0;

      claimableRef.current = nextClaimable;
      setClaimable(nextClaimable);

      if (isStreaming && nextClaimable < maxClaimable) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const handleVisibilityChange = () => {
      if (!document.hidden && isStreaming) {
        // Resync to the true elapsed-time value instead of resuming from a
        // stale tick, then continue ticking from the corrected value.
        lastFrameTime = performance.now();
        claimableRef.current = computeClaimable();
        setClaimable(claimableRef.current);
      }
    };

    if (reduceMotion && isStreaming) {
      // #1198 — Respect prefers-reduced-motion: compute the accrued value once
      // and skip the per-frame animation loop entirely.
      claimableRef.current = computeClaimable();
      setClaimable(claimableRef.current);
    } else if (isStreaming) {
      rafId = requestAnimationFrame(tick);
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [
    isActive,
    isPaused,
    maxClaimable,
    pausedAt,
    ratePerSecond,
    startTime,
    lastUpdateTime,
    totalPausedDuration,
  ]);

  return claimable;
}
