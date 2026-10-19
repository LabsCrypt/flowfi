'use client';

import { useCallback, useMemo, useState } from 'react';
import type { AnalyticsFilters, ExportFormat, Stream } from '@/types/analytics';
import { FilterToolbar, type TokenOption } from '@/components/analytics/FilterToolbar';
import { KpiMetricCard } from '@/components/analytics/KpiMetricCard';
import { applyFilters } from '@/utils/analytics-filters';
import {
  analyzeStreams,
  buildTokenVolumeSeries,
  computeAggregates,
} from '@/utils/stream-metrics';
import { exportStreams } from '@/utils/export-accounting';
import {
  formatInteger,
  formatRunway,
  formatTokenAmount,
  formatUsd,
  formatUsdCompact,
  shortenAddress,
  tokenColor,
} from '@/utils/format';

export interface StreamAnalyticsViewProps {
  streams: Stream[];
  filters: AnalyticsFilters;
  onFiltersChange: (patch: Partial<AnalyticsFilters>) => void;
  onResetFilters: () => void;
  walletAddress?: string;
  isLoading?: boolean;
  error?: Error | null;
}

export function StreamAnalyticsView({
  streams,
  filters,
  onFiltersChange,
  onResetFilters,
  walletAddress,
  isLoading = false,
  error = null,
}: StreamAnalyticsViewProps) {
  const [exporting, setExporting] = useState<ExportFormat | null>(null);

  const tokenOptions: TokenOption[] = useMemo(() => {
    const map = new Map<string, TokenOption>();
    for (const stream of streams) {
      const symbol = stream.token?.symbol ?? 'UNKNOWN';
      if (!map.has(symbol)) {
        map.set(symbol, {
          symbol,
          address: stream.token?.address ?? '',
          logoURI: stream.token?.logoURI,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
  }, [streams]);

  const filtered = useMemo(
    () => applyFilters(streams, filters, { walletAddress }),
    [streams, filters, walletAddress],
  );

  const analyzed = useMemo(() => analyzeStreams(filtered), [filtered]);
  const aggregates = useMemo(() => computeAggregates(analyzed), [analyzed]);
  const volumeSeries = useMemo(() => buildTokenVolumeSeries(filtered), [filtered]);

  const handleExport = useCallback(
    (format: ExportFormat) => {
      setExporting(format);
      try {
        exportStreams(filtered, format);
      } finally {
        setExporting(null);
      }
    },
    [filtered],
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">
          Stream Analytics Explorer
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Multi-dimensional filtering, aggregate financial metrics, and accounting exports for
          high-scale streaming operations.
        </p>
      </header>

      <FilterToolbar
        filters={filters}
        onChange={onFiltersChange}
        onReset={onResetFilters}
        tokens={tokenOptions}
        resultCount={filtered.length}
        totalCount={streams.length}
        roleDisabled={!walletAddress}
      />

      {error ? (
        <div
          role="alert"
          className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300"
        >
          {error.message}
        </div>
      ) : null}

      <section
        aria-label="Key metrics"
        data-testid="kpi-ribbon"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <KpiMetricCard
          label="Total Value Streamed"
          value={formatUsd(aggregates.totalValueStreamedUsd)}
          subtitle={`${formatInteger(aggregates.totalStreams)} streams`}
          isLoading={isLoading}
          valueTestId="kpi-tvs"
        />
        <KpiMetricCard
          label="Outflow Velocity"
          value={`${formatUsdCompact(aggregates.outflowPerHourUsd)}/hr`}
          subtitle={`${formatUsdCompact(aggregates.outflowPerDayUsd)} per day • ${formatUsdCompact(aggregates.outflowPerMonthUsd)} per month`}
          isLoading={isLoading}
          valueTestId="kpi-outflow"
        />
        <KpiMetricCard
          label="Active Positions"
          value={formatInteger(aggregates.activePositions)}
          subtitle={`of ${formatInteger(aggregates.totalStreams)} total`}
          isLoading={isLoading}
          valueTestId="kpi-active"
        />
        <KpiMetricCard
          label="Avg Runway Remaining"
          value={formatRunway(aggregates.averageRunwayDays)}
          subtitle={
            aggregates.aggregateRunwayDays > 0
              ? `Aggregate ${formatRunway(aggregates.aggregateRunwayDays)}`
              : 'No active outflow'
          }
          isLoading={isLoading}
          tone={
            aggregates.averageRunwayDays < 7 && aggregates.activePositions > 0
              ? 'warning'
              : 'default'
          }
          valueTestId="kpi-runway"
        />
      </section>

      <section
        aria-label="Token volume over time"
        data-testid="volume-chart"
        className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
            Token Volume Over Time
          </h2>
          <div className="flex flex-wrap gap-2">
            {volumeSeries.tokens.map((symbol) => (
              <span
                key={symbol}
                className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: tokenColor(symbol) }}
                />
                {symbol}
              </span>
            ))}
          </div>
        </div>

        {volumeSeries.total === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500" data-testid="volume-empty">
            No volume in the current selection.
          </p>
        ) : (
          <div className="flex h-40 items-end gap-1">
            {volumeSeries.points.map((point) => {
              const max = Math.max(...volumeSeries.points.map((p) => p.total), 1);
              return (
                <div
                  key={point.bucketStart}
                  className="flex flex-1 flex-col items-center gap-1"
                  title={`${point.label}: ${formatUsdCompact(point.total)}`}
                >
                  <div
                    className="flex w-full flex-col justify-end"
                    style={{ height: '120px' }}
                  >
                    {volumeSeries.tokens.map((symbol) => {
                      const value = point.values[symbol] ?? 0;
                      if (value <= 0) return null;
                      return (
                        <div
                          key={symbol}
                          style={{
                            height: `${(value / max) * 100}%`,
                            background: tokenColor(symbol),
                          }}
                          className="w-full"
                        />
                      );
                    })}
                  </div>
                  <span className="text-[10px] text-slate-400">{point.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section
        aria-label="Streams"
        data-testid="streams-table"
        className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4 dark:border-slate-800">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Streams</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Showing {formatInteger(filtered.length)} of {formatInteger(streams.length)}
            </p>
          </div>
          <div className="flex gap-2">
            {(['csv', 'json', 'quickbooks'] as const).map((format) => (
              <button
                key={format}
                type="button"
                disabled={filtered.length === 0 || exporting !== null}
                onClick={() => handleExport(format)}
                data-testid={`export-${format}`}
                className="h-8 rounded-lg border border-slate-300 px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                {format === 'quickbooks' ? 'QuickBooks' : format.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="p-10 text-center" data-testid="zero-state">
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
              No streams match your filters.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Adjust the filters above or clear them to see all streams.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500 dark:bg-slate-950 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2">Stream</th>
                  <th className="px-4 py-2">Recipient</th>
                  <th className="px-4 py-2">Token</th>
                  <th className="px-4 py-2 text-right">Deposited</th>
                  <th className="px-4 py-2 text-right">Remaining</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2 text-right">Runway</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {analyzed.map((stream) => (
                  <tr key={stream.id} data-testid={`stream-row-${stream.id}`}>
                    <td className="px-4 py-2 font-mono text-xs">
                      {stream.id.slice(0, 10)}…
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {shortenAddress(stream.recipient)}
                    </td>
                    <td className="px-4 py-2">{stream.token?.symbol ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatTokenAmount(stream.metrics.deposited, stream.token?.symbol ?? '')}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {formatTokenAmount(stream.metrics.remaining, stream.token?.symbol ?? '')}
                    </td>
                    <td className="px-4 py-2">
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs capitalize text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                        {stream.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {stream.metrics.isActive ? formatRunway(stream.metrics.runwayDays) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default StreamAnalyticsView;
