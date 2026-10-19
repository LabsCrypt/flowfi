'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnalyticsFilters,
  DateRangePreset,
  RunwayThreshold,
  StatusFilterOption,
  StreamRoleFilter,
} from '@/types/analytics';
import {
  DATE_RANGE_OPTIONS,
  ROLE_OPTIONS,
  RUNWAY_OPTIONS,
  STATUS_OPTIONS,
  countActiveFilters,
} from '@/utils/analytics-filters';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { tokenColor } from '@/utils/format';

export interface TokenOption {
  symbol: string;
  address: string;
  logoURI?: string;
}

export interface FilterToolbarProps {
  filters: AnalyticsFilters;
  onChange: (patch: Partial<AnalyticsFilters>) => void;
  onReset: () => void;
  tokens: TokenOption[];
  resultCount: number;
  totalCount: number;
  roleDisabled?: boolean;
  searchDebounceMs?: number;
}

interface MultiSelectOption {
  value: string;
  label: string;
  description?: string;
  logoURI?: string;
}

interface MultiSelectProps {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
  testId?: string;
}

function MultiSelect({
  label,
  options,
  selected,
  onChange,
  searchable = false,
  searchPlaceholder = 'Search…',
  emptyLabel = 'No options',
  testId,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // Reset the search box whenever the dropdown closes (adjusting state during
  // render avoids a cascading effect-driven re-render).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setQuery('');
  }

  const visibleOptions = useMemo(() => {
    if (!searchable || !query.trim()) return options;
    const needle = query.trim().toLowerCase();
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) ||
        (option.description ?? '').toLowerCase().includes(needle),
    );
  }, [options, query, searchable]);

  const toggle = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((entry) => entry !== value)
        : [...selected, value],
    );
  };

  const buttonLabel = selected.length > 0 ? `${label} (${selected.length})` : label;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
        data-testid={testId}
        className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors ${
          selected.length > 0
            ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
            : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'
        }`}
      >
        <span>{buttonLabel}</span>
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open ? (
        <div
          role="listbox"
          aria-multiselectable="true"
          className="absolute left-0 z-30 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {searchable ? (
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={`Search ${label}`}
              className="mb-2 h-8 w-full rounded-md border border-slate-300 px-2 text-sm outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          ) : null}

          <div className="max-h-60 overflow-y-auto">
            {visibleOptions.length === 0 ? (
              <p className="px-2 py-3 text-sm text-slate-500">{emptyLabel}</p>
            ) : (
              visibleOptions.map((option) => {
                const checked = selected.includes(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    onClick={() => toggle(option.value)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        checked
                          ? 'border-indigo-600 bg-indigo-600 text-white'
                          : 'border-slate-300 dark:border-slate-600'
                      }`}
                    >
                      {checked ? (
                        <svg viewBox="0 0 20 20" className="h-3 w-3" fill="currentColor">
                          <path
                            fillRule="evenodd"
                            d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.8 3.8 6.8-6.8a1 1 0 011.4 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      ) : null}
                    </span>

                    {option.logoURI ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={option.logoURI}
                        alt=""
                        className="h-4 w-4 shrink-0 rounded-full"
                      />
                    ) : (
                      <span
                        className="h-4 w-4 shrink-0 rounded-full"
                        style={{ background: tokenColor(option.label) }}
                        aria-hidden="true"
                      />
                    )}

                    <span className="flex-1 truncate text-slate-800 dark:text-slate-100">
                      {option.label}
                    </span>
                    {option.description ? (
                      <span className="truncate text-xs text-slate-400">
                        {option.description}
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function FilterToolbar({
  filters,
  onChange,
  onReset,
  tokens,
  resultCount,
  totalCount,
  roleDisabled = false,
  searchDebounceMs = 300,
}: FilterToolbarProps) {
  const [searchInput, setSearchInput] = useState(filters.search);
  const debouncedSearch = useDebouncedValue(searchInput, searchDebounceMs);
  const lastSyncedRef = useRef(filters.search);

  useEffect(() => {
    if (debouncedSearch === lastSyncedRef.current) return;
    lastSyncedRef.current = debouncedSearch;
    onChange({ search: debouncedSearch });
  }, [debouncedSearch, onChange]);

  // Mirror external changes to `filters.search` (e.g. a reset) into the input,
  // ignoring echoes of the value we just emitted.
  const [prevSearch, setPrevSearch] = useState(filters.search);
  if (filters.search !== prevSearch) {
    setPrevSearch(filters.search);
    if (filters.search !== debouncedSearch) setSearchInput(filters.search);
  }

  const tokenOptions: MultiSelectOption[] = useMemo(
    () =>
      tokens.map((token) => ({
        value: token.symbol,
        label: token.symbol,
        description: token.address ? `${token.address.slice(0, 6)}…` : undefined,
        logoURI: token.logoURI,
      })),
    [tokens],
  );

  const activeCount = countActiveFilters(filters);

  const handleReset = () => {
    setSearchInput('');
    lastSyncedRef.current = '';
    onReset();
  };

  return (
    <section
      aria-label="Stream filters"
      data-testid="filter-toolbar"
      className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          >
            <path
              fillRule="evenodd"
              d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.45 4.39l3.08 3.08a.75.75 0 11-1.06 1.06l-3.08-3.08A7 7 0 012 9z"
              clipRule="evenodd"
            />
          </svg>
          <input
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search recipient, sender, memo, or stream ID…"
            aria-label="Search streams"
            data-testid="filter-search"
            className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-800 outline-none placeholder:text-slate-400 focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          />
        </div>

        <MultiSelect
          label="Tokens"
          options={tokenOptions}
          selected={filters.tokens}
          onChange={(next) => onChange({ tokens: next })}
          searchable
          searchPlaceholder="Search tokens…"
          emptyLabel="No tokens found"
          testId="filter-tokens"
        />

        <MultiSelect
          label="Status"
          options={STATUS_OPTIONS.map((option) => ({
            value: option.value,
            label: option.label,
          }))}
          selected={filters.statuses}
          onChange={(next) => onChange({ statuses: next as StatusFilterOption[] })}
          testId="filter-status"
        />

        <select
          value={filters.dateRange}
          onChange={(event) => onChange({ dateRange: event.target.value as DateRangePreset })}
          aria-label="Date range"
          data-testid="filter-date-range"
          className="h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-700 outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        >
          {DATE_RANGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <div
          role="group"
          aria-label="Role"
          data-testid="filter-role"
          title={roleDisabled ? 'Connect a wallet to filter by role' : undefined}
          className={`flex h-9 items-center rounded-lg border border-slate-300 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900 ${
            roleDisabled ? 'opacity-50' : ''
          }`}
        >
          {ROLE_OPTIONS.map((option) => {
            const active = filters.role === option.value;
            return (
              <button
                key={option.value}
                type="button"
                disabled={roleDisabled}
                aria-pressed={active}
                onClick={() => onChange({ role: option.value as StreamRoleFilter })}
                data-testid={`filter-role-${option.value}`}
                className={`h-full rounded-md px-2.5 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        <select
          value={filters.runway}
          onChange={(event) => onChange({ runway: event.target.value as RunwayThreshold })}
          aria-label="Runway threshold"
          data-testid="filter-runway"
          className="h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-700 outline-none focus:border-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
        >
          {RUNWAY_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        {activeCount > 0 ? (
          <button
            type="button"
            onClick={handleReset}
            data-testid="filter-reset"
            className="h-9 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Clear ({activeCount})
          </button>
        ) : null}
      </div>

      {filters.dateRange === 'custom' ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="custom-range">
          <label className="text-xs text-slate-500">
            From
            <input
              type="date"
              value={filters.customStart}
              onChange={(event) => onChange({ customStart: event.target.value })}
              className="ml-2 h-8 rounded-md border border-slate-300 px-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </label>
          <label className="text-xs text-slate-500">
            To
            <input
              type="date"
              value={filters.customEnd}
              onChange={(event) => onChange({ customEnd: event.target.value })}
              className="ml-2 h-8 rounded-md border border-slate-300 px-2 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
            />
          </label>
        </div>
      ) : null}

      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
        <span data-testid="filter-result-count">
          Showing <strong className="text-slate-700 dark:text-slate-200">{resultCount}</strong> of{' '}
          {totalCount} streams
        </span>
        {activeCount > 0 ? <span>{activeCount} filter(s) active</span> : null}
      </div>
    </section>
  );
}

export default FilterToolbar;
