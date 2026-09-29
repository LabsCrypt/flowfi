'use client';

import type { ReactNode } from 'react';

export type KpiTone = 'default' | 'positive' | 'warning' | 'danger';

export interface KpiMetricCardProps {
  label: string;
  value: string;
  subtitle?: string;
  hint?: string;
  icon?: ReactNode;
  tone?: KpiTone;
  isLoading?: boolean;
  valueTestId?: string;
}

const TONE_CLASSES: Record<KpiTone, string> = {
  default: 'text-slate-900 dark:text-slate-50',
  positive: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-rose-600 dark:text-rose-400',
};

export function KpiMetricCard({
  label,
  value,
  subtitle,
  hint,
  icon,
  tone = 'default',
  isLoading = false,
  valueTestId,
}: KpiMetricCardProps) {
  if (isLoading) {
    return <KpiMetricCardSkeleton label={label} />;
  }

  return (
    <div
      className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-colors dark:border-slate-800 dark:bg-slate-900"
      data-testid="kpi-metric-card"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {label}
        </span>
        {icon ? <span aria-hidden="true">{icon}</span> : null}
      </div>

      <span
        className={`text-2xl font-semibold tabular-nums ${TONE_CLASSES[tone]}`}
        data-testid={valueTestId}
        title={hint}
      >
        {value}
      </span>

      {subtitle ? (
        <span className="text-xs text-slate-500 dark:text-slate-400">{subtitle}</span>
      ) : null}
    </div>
  );
}

export function KpiMetricCardSkeleton({ label }: { label?: string }) {
  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      data-testid="kpi-metric-card-skeleton"
      aria-busy="true"
    >
      <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label ?? '\u00A0'}
      </span>
      <span className="h-7 w-28 animate-pulse rounded bg-slate-200 dark:bg-slate-700" />
      <span className="h-3 w-20 animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
    </div>
  );
}

export default KpiMetricCard;
