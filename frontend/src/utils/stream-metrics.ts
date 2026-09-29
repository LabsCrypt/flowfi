import type {
  AggregateMetrics,
  AnalyzedStream,
  Stream,
  StreamMetrics,
  TokenOutflow,
} from '@/types/analytics';

export const SECONDS_PER_HOUR = 3_600;
export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_MONTH = 30 * SECONDS_PER_DAY;

export const LOW_RUNWAY_DAYS = 7;
export const LOW_RUNWAY_HOURS = 24;

export function toBigInt(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? BigInt(Math.trunc(value)) : 0n;
  }
  const trimmed = String(value).trim();
  if (!trimmed) return 0n;
  const [whole] = trimmed.split('.');
  try {
    return BigInt(whole || '0');
  } catch {
    return 0n;
  }
}

export function formatUnits(
  raw: string | number | bigint | null | undefined,
  decimals: number,
): number {
  const value = toBigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(Math.max(0, decimals));
  const whole = abs / base;
  const fraction = abs % base;
  const result = Number(whole) + Number(fraction) / Number(base);
  return negative ? -result : result;
}

export function toDecimalString(
  raw: string | number | bigint | null | undefined,
  decimals: number,
): string {
  const value = toBigInt(raw);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(Math.max(0, decimals));
  const whole = abs / base;
  const fraction = abs % base;
  const sign = negative ? '-' : '';
  if (decimals <= 0) return `${sign}${whole}`;
  const fractionStr = fraction.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fractionStr ? `${sign}${whole}.${fractionStr}` : `${sign}${whole}`;
}

export function computeStreamMetrics(stream: Stream, nowMs: number = Date.now()): StreamMetrics {
  const decimals = stream.token?.decimals ?? 18;
  const deposited = formatUnits(stream.depositedAmount, decimals);
  const withdrawn = formatUnits(stream.withdrawnAmount, decimals);
  const remaining = formatUnits(stream.remainingBalance, decimals);
  const claimable = formatUnits(stream.claimableBalance, decimals);

  const duration = Math.max(0, stream.endTimestamp - stream.startTimestamp);
  const ratePerSecond = duration > 0 ? deposited / duration : 0;

  const nowSeconds = Math.floor(nowMs / 1000);
  const secondsRemaining = Math.max(0, stream.endTimestamp - nowSeconds);
  const isActive = stream.status === 'active' && secondsRemaining > 0;

  let runwayDays = 0;
  if (isActive) {
    if (ratePerSecond > 0) {
      const secondsUntilExhaustion = Math.min(remaining / ratePerSecond, secondsRemaining);
      runwayDays = Math.max(0, secondsUntilExhaustion) / SECONDS_PER_DAY;
    } else {
      runwayDays = secondsRemaining / SECONDS_PER_DAY;
    }
  }

  const usdRate = stream.usdRate ?? 0;

  return {
    deposited,
    withdrawn,
    remaining,
    claimable,
    ratePerSecond,
    runwayDays,
    secondsRemaining,
    valueStreamedUsd: deposited * usdRate,
    remainingUsd: remaining * usdRate,
    isActive,
    isLowRunway: isActive && runwayDays < LOW_RUNWAY_DAYS,
  };
}

export function analyzeStream(stream: Stream, nowMs: number = Date.now()): AnalyzedStream {
  return { ...stream, metrics: computeStreamMetrics(stream, nowMs) };
}

export function analyzeStreams(streams: Stream[], nowMs: number = Date.now()): AnalyzedStream[] {
  return streams.map((stream) => analyzeStream(stream, nowMs));
}

export function isLowRunway(
  stream: Stream,
  nowMs: number = Date.now(),
  thresholdDays: number = LOW_RUNWAY_DAYS,
): boolean {
  const metrics = computeStreamMetrics(stream, nowMs);
  return metrics.isActive && metrics.runwayDays < thresholdDays;
}

export function computeAggregates(streams: AnalyzedStream[]): AggregateMetrics {
  let totalValueStreamedUsd = 0;
  let totalRemainingUsd = 0;
  let activePositions = 0;
  let runwaySum = 0;
  let outflowPerSecondUsd = 0;
  let hasUsdPricing = false;

  const valueByToken = new Map<string, number>();
  const rateByToken = new Map<string, number>();

  for (const stream of streams) {
    const { metrics } = stream;
    const symbol = stream.token?.symbol ?? 'UNKNOWN';
    const usdRate = stream.usdRate ?? 0;

    if (usdRate > 0) hasUsdPricing = true;

    totalValueStreamedUsd += metrics.valueStreamedUsd;
    totalRemainingUsd += metrics.remainingUsd;

    valueByToken.set(symbol, (valueByToken.get(symbol) ?? 0) + metrics.deposited);

    if (metrics.isActive) {
      activePositions += 1;
      runwaySum += metrics.runwayDays;
      outflowPerSecondUsd += metrics.ratePerSecond * usdRate;
      rateByToken.set(symbol, (rateByToken.get(symbol) ?? 0) + metrics.ratePerSecond);
    }
  }

  const outflowPerDayUsd = outflowPerSecondUsd * SECONDS_PER_DAY;
  const aggregateRunwayDays =
    outflowPerDayUsd > 0 ? totalRemainingUsd / outflowPerDayUsd : 0;

  const outflowByToken: TokenOutflow[] = Array.from(rateByToken.entries())
    .map(([symbol, perSecond]) => ({
      symbol,
      perHour: perSecond * SECONDS_PER_HOUR,
      perDay: perSecond * SECONDS_PER_DAY,
      perMonth: perSecond * SECONDS_PER_MONTH,
    }))
    .sort((a, b) => b.perMonth - a.perMonth);

  return {
    totalStreams: streams.length,
    totalValueStreamedUsd,
    totalValueStreamedByToken: Array.from(valueByToken.entries())
      .map(([symbol, amount]) => ({ symbol, amount }))
      .sort((a, b) => b.amount - a.amount),
    totalRemainingUsd,
    hasUsdPricing,
    outflowPerHourUsd: outflowPerSecondUsd * SECONDS_PER_HOUR,
    outflowPerDayUsd,
    outflowPerMonthUsd: outflowPerSecondUsd * SECONDS_PER_MONTH,
    outflowByToken,
    activePositions,
    averageRunwayDays: activePositions > 0 ? runwaySum / activePositions : 0,
    aggregateRunwayDays: Number.isFinite(aggregateRunwayDays) ? aggregateRunwayDays : 0,
  };
}

export interface TokenVolumePoint {
  label: string;
  bucketStart: number;
  values: Record<string, number>;
  total: number;
}

export interface TokenVolumeSeries {
  points: TokenVolumePoint[];
  tokens: string[];
  unit: 'usd' | 'token';
  unpricedStreams: number;
  total: number;
}

export interface BuildVolumeSeriesOptions {
  now?: number;
  maxBuckets?: number;
  unit?: 'usd' | 'token';
}

export function buildTokenVolumeSeries(
  streams: Stream[],
  options: BuildVolumeSeriesOptions = {},
): TokenVolumeSeries {
  const { now = Date.now(), maxBuckets = 12, unit = 'usd' } = options;

  if (streams.length === 0) {
    return { points: [], tokens: [], unit, unpricedStreams: 0, total: 0 };
  }

  const timestamps = streams
    .map((stream) => Date.parse(stream.createdAt))
    .filter((value) => Number.isFinite(value));

  const minTs = timestamps.length > 0 ? Math.min(...timestamps) : now;
  const spanMs = Math.max(now - minTs, 1);
  const bucketMs = Math.max(spanMs / maxBuckets, 60 * 60 * 1000);

  const buckets = new Map<number, TokenVolumePoint>();
  for (let i = 0; i < maxBuckets; i += 1) {
    const bucketStart = minTs + i * bucketMs;
    buckets.set(bucketStart, {
      label: new Date(bucketStart).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      }),
      bucketStart,
      values: {},
      total: 0,
    });
  }

  const orderedStarts = Array.from(buckets.keys()).sort((a, b) => a - b);
  const tokenSet = new Set<string>();
  let unpricedStreams = 0;

  for (const stream of streams) {
    const created = Date.parse(stream.createdAt);
    if (!Number.isNaN(created)) {
      const index = Math.min(
        orderedStarts.length - 1,
        Math.max(0, Math.floor((created - minTs) / bucketMs)),
      );
      const bucketKey = orderedStarts[index];
      const bucket = bucketKey !== undefined ? buckets.get(bucketKey) : undefined;
      if (bucket) {
        const symbol = stream.token?.symbol ?? 'UNKNOWN';
        const decimals = stream.token?.decimals ?? 18;
        const amount = formatUnits(stream.depositedAmount, decimals);
        const rate = stream.usdRate ?? 0;

        let value: number;
        if (unit === 'usd') {
          if (rate <= 0) {
            unpricedStreams += 1;
            continue;
          }
          value = amount * rate;
        } else {
          value = amount;
        }

        bucket.values[symbol] = (bucket.values[symbol] ?? 0) + value;
        bucket.total += value;
        tokenSet.add(symbol);
      }
    } else if (unit === 'usd' && (stream.usdRate ?? 0) <= 0) {
      unpricedStreams += 1;
    }
  }

  const points = orderedStarts.map((start) => buckets.get(start) as TokenVolumePoint);

  return {
    points,
    tokens: Array.from(tokenSet).sort(),
    unit,
    unpricedStreams,
    total: points.reduce((sum, point) => sum + point.total, 0),
  };
}
