'use client';

import { useEffect, useRef, useState } from 'react';
import type { FlowFiStream } from '../types';
import { computeClaimable } from '../utils/math';

export interface UseClaimableBalanceOptions {
  /** Animation frame interval in ms. Default 100ms (sub-second). */
  intervalMs?: number;
  /** Disable the animation loop (returns the current value only). */
  enabled?: boolean;
}

export interface UseClaimableBalanceResult {
  /** Animated numeric value in whole-token units. */
  claimable: number;
  /** Raw base-unit amount as an integer string. */
  claimableRaw: string;
}

function toRaw(value: number, decimals: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const base = 10 ** decimals;
  return BigInt(Math.round(value * base)).toString();
}

export function useClaimableBalance(
  stream: FlowFiStream | null | undefined,
  options: UseClaimableBalanceOptions = {},
): UseClaimableBalanceResult {
  const { intervalMs = 100, enabled = true } = options;

  // Seed with the current value so the very first render is correct.
  const [claimable, setClaimable] = useState(() =>
    stream ? computeClaimable(stream, Date.now()) : 0,
  );
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!stream) {
      setClaimable(0);
      return;
    }

    // Sync immediately whenever the stream changes.
    setClaimable(computeClaimable(stream, Date.now()));
    if (!enabled) return;

    let last = 0;
    const tick = (timestamp: number) => {
      if (timestamp - last >= intervalMs) {
        last = timestamp;
        setClaimable(computeClaimable(stream, Date.now()));
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [stream, enabled, intervalMs]);

  const decimals = stream?.token?.decimals ?? 18;
  return { claimable, claimableRaw: toRaw(claimable, decimals) };
}
