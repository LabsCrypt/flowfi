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
    let lastFrameTime = performance.now();

    const nowSeconds = Date.now() / 1000;
    const streamStartTime = startTime ?? lastUpdateTime ?? nowSeconds;
    const elapsedSinceStart = Math.max(0, nowSeconds - streamStartTime);
    const currentPauseDuration =
      isPaused && pausedAt ? Math.max(0, nowSeconds - pausedAt) : 0;
    const effectiveElapsed = Math.max(
      0,
      elapsedSinceStart - totalPausedDuration - currentPauseDuration,
    );

    claimableRef.current = clamp(
      effectiveElapsed * ratePerSecond,
      0,
      maxClaimable,
    );
    setClaimable(claimableRef.current);

    const tick = (frameTime: number) => {
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

    if (isStreaming) {
      rafId = requestAnimationFrame(tick);
    }

    return () => {
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
