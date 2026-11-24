/**
 * Shared domain types for the Stream Analytics Explorer.
 */

export type StreamStatus = 'active' | 'paused' | 'completed' | 'cancelled';

/** `low_runway` is a derived pseudo-status used only for filtering. */
export type StatusFilterOption = StreamStatus | 'low_runway';

export type StreamRoleFilter = 'sender' | 'recipient' | 'both';

export type DateRangePreset =
  | 'today'
  | '7d'
  | '30d'
  | 'mtd'
  | 'qtd'
  | 'all'
  | 'custom';

export type RunwayThreshold = 'any' | 'lt7d' | 'lt24h';

export type ExportFormat = 'csv' | 'json' | 'quickbooks';

export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
  logoURI?: string;
}

export interface Stream {
  id: string;
  createdAt: string;
  sender: string;
  recipient: string;
  memo?: string;
  token: TokenInfo;
  depositedAmount: string;
  withdrawnAmount: string;
  remainingBalance: string;
  claimableBalance: string;
  startTimestamp: number;
  endTimestamp: number;
  cliffTimestamp: number;
  status: StreamStatus;
  lastActionLedger: number;
  usdRate?: number;
}

export interface StreamMetrics {
  deposited: number;
  withdrawn: number;
  remaining: number;
  claimable: number;
  ratePerSecond: number;
  runwayDays: number;
  secondsRemaining: number;
  valueStreamedUsd: number;
  remainingUsd: number;
  isActive: boolean;
  isLowRunway: boolean;
}

export interface AnalyzedStream extends Stream {
  metrics: StreamMetrics;
}

export interface TokenOutflow {
  symbol: string;
  perHour: number;
  perDay: number;
  perMonth: number;
}

export interface AggregateMetrics {
  totalStreams: number;
  totalValueStreamedUsd: number;
  totalValueStreamedByToken: Array<{ symbol: string; amount: number }>;
  totalRemainingUsd: number;
  hasUsdPricing: boolean;
  outflowPerHourUsd: number;
  outflowPerDayUsd: number;
  outflowPerMonthUsd: number;
  outflowByToken: TokenOutflow[];
  activePositions: number;
  averageRunwayDays: number;
  aggregateRunwayDays: number;
}

export interface AnalyticsFilters {
  tokens: string[];
  statuses: StatusFilterOption[];
  role: StreamRoleFilter;
  dateRange: DateRangePreset;
  customStart: string;
  customEnd: string;
  runway: RunwayThreshold;
  search: string;
}
