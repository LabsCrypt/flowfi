'use client';

import { useStreamRunway } from '../hooks/useStreamRunway';
import type { FlowFiStream } from '../types';

export interface StreamRunwayProgressProps {
  stream: FlowFiStream | null | undefined;
  alertThresholdHours?: number;
  className?: string;
  showLabel?: boolean;
}

export function StreamRunwayProgress({
  stream,
  alertThresholdHours = 48,
  className,
  showLabel = true,
}: StreamRunwayProgressProps) {
  const { progress, isAlert, runwayDays } = useStreamRunway(stream, alertThresholdHours);
  const percent = Math.min(100, Math.max(0, progress * 100));

  return (
    <div data-testid="runway-progress" className={className}>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          role="progressbar"
          aria-valuenow={Math.round(percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{ width: `${percent}%` }}
          data-testid="runway-bar"
          className={`h-full transition-all ${
            isAlert ? 'bg-amber-500' : 'bg-indigo-500'
          }`}
        />
      </div>
      {showLabel ? (
        <p
          className="mt-1 text-xs text-slate-500"
          data-testid="runway-label"
        >
          {isAlert ? '⚠️ ' : ''}
          {runwayDays.toFixed(runwayDays < 1 ? 1 : 0)} day{runwayDays === 1 ? '' : 's'} left
        </p>
      ) : null}
    </div>
  );
}
