'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { StreamAnalyticsView } from '@/components/analytics/StreamAnalyticsView';
import {
  DEFAULT_FILTERS,
  filtersFromSearchParams,
  filtersToSearchParams,
} from '@/utils/analytics-filters';
import { useStreams } from '@/hooks/useStreams';
import type { AnalyticsFilters } from '@/types/analytics';

function AnalyticsExplorer() {
  const searchParams = useSearchParams();
  const initialFilters = useMemo(
    () => filtersFromSearchParams(searchParams),
    // Only hydrate once from the URL on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [filters, setFilters] = useState<AnalyticsFilters>(initialFilters);
  const { streams, isLoading, error } = useStreams();

  // Keep the URL in sync with the active filter state.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = filtersToSearchParams(filters);
    const query = params.toString();
    const next = query ? `${window.location.pathname}?${query}` : window.location.pathname;
    window.history.replaceState(null, '', next);
  }, [filters]);

  const handleChange = useCallback((patch: Partial<AnalyticsFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleReset = useCallback(() => setFilters({ ...DEFAULT_FILTERS }), []);

  return (
    <main className="mx-auto max-w-7xl p-4 sm:p-6">
      <StreamAnalyticsView
        streams={streams}
        filters={filters}
        onFiltersChange={handleChange}
        onResetFilters={handleReset}
        isLoading={isLoading}
        error={error}
      />
    </main>
  );
}

export default function AnalyticsPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-7xl p-6 text-sm text-slate-500">
          Loading analytics…
        </div>
      }
    >
      <AnalyticsExplorer />
    </Suspense>
  );
}
