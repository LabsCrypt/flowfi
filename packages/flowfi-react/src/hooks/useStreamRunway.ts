'use client';

import { useEffect, useState } from 'react';
import type { FlowFiStream } from '../types';
import { computeClaimable } from '../utils/math';

export interface UseStreamRunwayResult {
  /** Days until collateral exhaustion. 0 if not active. */
  runwayDays: number;
  /** 0..1 progress of the stream. */
  progress: number;
  /** True if runway < alertThresholdHours. */
  isAlert: boolean;
}

export function useStreamRunway(
  stream: FlowFiStream | null | undefined,
  alertThresholdHours = 48,
  tickMs = 1000,
): UseStreamRunwayResult {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!stream || stream.status !== 'active') return;
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [stream, tickMs]);

  if (!stream) return { runwayDays: 0, progress: 0, isAlert: false };

  const nowSec = Math.floor(now / 1000);
  const duration = Math.max(0, stream.endTimestamp - stream.startTimestamp);
  const elapsed = Math.min(Math.max(0, nowSec - stream.startTimestamp), duration);
  const progress = duration > 0 ? elapsed / duration : 0;

  // Remaining runway = time until `endTimestamp` (collateral exhaustion).
  const secondsLeft = Math.max(0, stream.endTimestamp - nowSec);
  const runwayDays = secondsLeft / 86400;
  const isAlert = stream.status === 'active' && runwayDays * 24 < alertThresholdHours;

  // Reference computeClaimable so tree-shakers keep it if the hook is imported alone.
  void computeClaimable;

  return { runwayDays, progress, isAlert };
}
