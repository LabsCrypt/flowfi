"use client";

import { useEffect, useMemo, useRef, useState } from "react";

interface UseStreamingAmountParams {
  deposited: number;
  withdrawn: number;
  ratePerSecond: number;
  lastUpdateTime: number;
  isActive: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function useStreamingAmount({
  deposited,
  withdrawn,
  ratePerSecond,
  lastUpdateTime,
  isActive,
}: UseStreamingAmountParams) {
  const maxClaimable = useMemo(
    () => Math.max(deposited - withdrawn, 0),
    [deposited, withdrawn],
  );

  const [claimable, setClaimable] = useState(0);
  const claimableRef = useRef(0);

  useEffect(() => {
    let rafId: number | null = null;
    const isStreaming = isActive && ratePerSecond > 0 && maxClaimable > 0;
    let lastFrameTime = performance.now();

    if (isStreaming) {
      const elapsedSeconds = Math.max(0, Date.now() / 1000 - lastUpdateTime);
      claimableRef.current = clamp(elapsedSeconds * ratePerSecond, 0, maxClaimable);
    } else {
      claimableRef.current = 0;
    }

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

    rafId = requestAnimationFrame(tick);

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [isActive, lastUpdateTime, maxClaimable, ratePerSecond]);

  return claimable;
}
