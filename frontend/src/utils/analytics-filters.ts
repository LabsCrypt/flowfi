import type {
  AnalyticsFilters,
  DateRangePreset,
  RunwayThreshold,
  StatusFilterOption,
  Stream,
  StreamRoleFilter,
} from '@/types/analytics';
import { LOW_RUNWAY_DAYS, computeStreamMetrics } from '@/utils/stream-metrics';

export const DEFAULT_FILTERS: AnalyticsFilters = {
  tokens: [],
  statuses: [],
  role: 'both',
  dateRange: 'all',
  customStart: '',
  customEnd: '',
  runway: 'any',
  search: '',
};

export const DATE_RANGE_OPTIONS: Array<{
  value: DateRangePreset;
  label: string;
  short: string;
}> = [
  { value: 'today', label: 'Today', short: 'Today' },
  { value: '7d', label: 'Last 7 Days', short: '7D' },
  { value: '30d', label: 'Last 30 Days', short: '30D' },
  { value: 'mtd', label: 'Month to Date', short: 'MTD' },
  { value: 'qtd', label: 'Quarter to Date', short: 'QTD' },
  { value: 'all', label: 'All Time', short: 'All' },
  { value: 'custom', label: 'Custom Range', short: 'Custom' },
];

export const STATUS_OPTIONS: Array<{ value: StatusFilterOption; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'low_runway', label: 'Low Runway' },
];

export const ROLE_OPTIONS: Array<{ value: StreamRoleFilter; label: string }> = [
  { value: 'both', label: 'Both' },
  { value: 'sender', label: 'Senders' },
  { value: 'recipient', label: 'Recipients' },
];

export const RUNWAY_OPTIONS: Array<{ value: RunwayThreshold; label: string }> = [
  { value: 'any', label: 'Any runway' },
  { value: 'lt7d', label: 'Under 7 days' },
  { value: 'lt24h', label: 'Under 24 hours' },
];

const VALID_STATUSES: StatusFilterOption[] = [
  'active',
  'paused',
  'completed',
  'cancelled',
  'low_runway',
];
const VALID_RANGES: DateRangePreset[] = ['today', '7d', '30d', 'mtd', 'qtd', 'all', 'custom'];
const VALID_ROLES: StreamRoleFilter[] = ['sender', 'recipient', 'both'];
const VALID_RUNWAY: RunwayThreshold[] = ['any', 'lt7d', 'lt24h'];

const DAY_MS = 86_400_000;

export interface ResolvedDateRange {
  startMs: number | null;
  endMs: number | null;
}

export function resolveDateRange(
  filters: AnalyticsFilters,
  now: Date = new Date(),
): ResolvedDateRange {
  const nowMs = now.getTime();

  switch (filters.dateRange) {
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { startMs: start.getTime(), endMs: nowMs };
    }
    case '7d':
      return { startMs: nowMs - 7 * DAY_MS, endMs: nowMs };
    case '30d':
      return { startMs: nowMs - 30 * DAY_MS, endMs: nowMs };
    case 'mtd': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { startMs: start.getTime(), endMs: nowMs };
    }
    case 'qtd': {
      const quarterStartMonth = Math.floor(now.getMonth() / 3) * 3;
      const start = new Date(now.getFullYear(), quarterStartMonth, 1);
      return { startMs: start.getTime(), endMs: nowMs };
    }
    case 'custom': {
      let startMs: number | null = null;
      let endMs: number | null = null;
      if (filters.customStart) {
        const parsed = new Date(`${filters.customStart}T00:00:00`).getTime();
        if (Number.isFinite(parsed)) startMs = parsed;
      }
      if (filters.customEnd) {
        const parsed = new Date(`${filters.customEnd}T23:59:59.999`).getTime();
        if (Number.isFinite(parsed)) endMs = parsed;
      }
      return { startMs, endMs };
    }
    case 'all':
    default:
      return { startMs: null, endMs: null };
  }
}

export function normalizeQuery(query: string): string {
  return (query ?? '').trim().toLowerCase();
}

export function matchesSearch(stream: Stream, query: string): boolean {
  const normalized = normalizeQuery(query);
  if (!normalized) return true;
  const haystack = [
    stream.id,
    stream.sender,
    stream.recipient,
    stream.memo ?? '',
    stream.token?.symbol ?? '',
    stream.token?.address ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return normalized.split(/\s+/).every((term) => haystack.includes(term));
}

export interface FilterContext {
  now?: number;
  walletAddress?: string;
}

export function applyFilters(
  streams: Stream[],
  filters: AnalyticsFilters,
  context: FilterContext = {},
): Stream[] {
  const now = context.now ?? Date.now();
  const { startMs, endMs } = resolveDateRange(filters, new Date(now));
  const query = normalizeQuery(filters.search);
  const tokenSet = new Set(filters.tokens.map((token) => token.toLowerCase()));
  const statusSet = new Set<StatusFilterOption>(filters.statuses);
  const wallet = context.walletAddress?.toLowerCase();

  return streams.filter((stream) => {
    if (tokenSet.size > 0) {
      const symbol = (stream.token?.symbol ?? '').toLowerCase();
      const address = (stream.token?.address ?? '').toLowerCase();
      if (!tokenSet.has(symbol) && !tokenSet.has(address)) return false;
    }

    if (statusSet.size > 0) {
      const metrics = computeStreamMetrics(stream, now);
      const matchesLowRunway = statusSet.has('low_runway') && metrics.isLowRunway;
      const matchesStatus = statusSet.has(stream.status);
      if (!matchesLowRunway && !matchesStatus) return false;
    }

    if (startMs !== null || endMs !== null) {
      const created = Date.parse(stream.createdAt);
      if (!Number.isFinite(created)) return false;
      if (startMs !== null && created < startMs) return false;
      if (endMs !== null && created > endMs) return false;
    }

    if (filters.role !== 'both' && wallet) {
      if (filters.role === 'sender' && stream.sender.toLowerCase() !== wallet) return false;
      if (filters.role === 'recipient' && stream.recipient.toLowerCase() !== wallet) return false;
    }

    if (filters.runway !== 'any') {
      const metrics = computeStreamMetrics(stream, now);
      if (!metrics.isActive) return false;
      const thresholdDays = filters.runway === 'lt24h' ? 1 : LOW_RUNWAY_DAYS;
      if (!(metrics.runwayDays < thresholdDays)) return false;
    }

    if (query && !matchesSearch(stream, query)) return false;

    return true;
  });
}

export function filtersToSearchParams(filters: AnalyticsFilters): URLSearchParams {
  const params = new URLSearchParams();

  if (filters.tokens.length > 0) params.set('token', filters.tokens.join(','));
  if (filters.statuses.length > 0) params.set('status', filters.statuses.join(','));
  if (filters.role !== 'both') params.set('role', filters.role);
  if (filters.dateRange !== 'all') params.set('range', filters.dateRange);
  if (filters.dateRange === 'custom') {
    if (filters.customStart) params.set('from', filters.customStart);
    if (filters.customEnd) params.set('to', filters.customEnd);
  }
  if (filters.runway !== 'any') params.set('runway', filters.runway);
  if (filters.search.trim()) params.set('q', filters.search.trim());

  return params;
}

type ReadonlyParams = { get(key: string): string | null };

export function filtersFromSearchParams(
  params: ReadonlyParams | URLSearchParams | null | undefined,
): AnalyticsFilters {
  if (!params) return { ...DEFAULT_FILTERS };

  const readList = (key: string): string[] =>
    (params.get(key) ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

  const rawRange = params.get('range') as DateRangePreset | null;
  const dateRange: DateRangePreset =
    rawRange && VALID_RANGES.includes(rawRange) ? rawRange : 'all';

  const statuses = readList('status').filter((status): status is StatusFilterOption =>
    VALID_STATUSES.includes(status as StatusFilterOption),
  );

  const rawRole = params.get('role') as StreamRoleFilter | null;
  const role: StreamRoleFilter =
    rawRole && VALID_ROLES.includes(rawRole) ? rawRole : 'both';

  const rawRunway = params.get('runway') as RunwayThreshold | null;
  const runway: RunwayThreshold =
    rawRunway && VALID_RUNWAY.includes(rawRunway) ? rawRunway : 'any';

  return {
    tokens: readList('token'),
    statuses,
    role,
    dateRange,
    customStart: params.get('from') ?? '',
    customEnd: params.get('to') ?? '',
    runway,
    search: params.get('q') ?? '',
  };
}

export function countActiveFilters(filters: AnalyticsFilters): number {
  let count = 0;
  if (filters.tokens.length > 0) count += 1;
  if (filters.statuses.length > 0) count += 1;
  if (filters.role !== 'both') count += 1;
  if (filters.dateRange !== 'all') count += 1;
  if (filters.runway !== 'any') count += 1;
  if (filters.search.trim()) count += 1;
  return count;
}

export function isDefaultFilters(filters: AnalyticsFilters): boolean {
  return countActiveFilters(filters) === 0;
}
