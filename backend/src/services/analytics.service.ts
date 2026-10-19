/**
 * Analytics Service — TimescaleDB-backed protocol TVL & velocity (Issue #1480)
 *
 * Reads the `stream_flow_snapshots` hypertable and its continuous aggregates
 * (`hourly_protocol_metrics`, `daily_protocol_metrics`) created by the
 * `20261001000000_add_timescaledb_analytics` migration. When TimescaleDB is
 * not installed (or the hypertable has not been created yet) every reader
 * degrades to live aggregation over the Prisma `Stream` table, so the
 * endpoints stay available on stock PostgreSQL deployments.
 */

import { pool, prisma } from "../lib/prisma.js";
import logger from "../logger.js";

/** Period accepted by the historical endpoint. */
export type AnalyticsPeriod = "7d" | "30d" | "90d" | "1y";

/** Interval accepted by the historical endpoint. */
export type AnalyticsInterval = "1h" | "1d";

const PERIOD_DAYS: Record<AnalyticsPeriod, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

export interface TokenTvl {
  tokenAddress: string;
  /** Sum of unwithdrawn stream balances, in stroops. */
  totalLockedStroops: string;
  /** Sum of per-second drip across active streams, in stroops/second. */
  velocityPerSecondStroops: string;
  activeStreamCount: number;
}

export interface TvlSnapshot {
  /** Where the numbers came from: the hypertable or live aggregation. */
  source: "timescaledb" | "live";
  tokens: TokenTvl[];
  /** Protocol-wide total locked, in stroops. */
  totalTvlStroops: string;
  generatedAt: string;
}

export interface HistoricalPoint {
  bucket: string;
  tokenAddress: string;
  avgTvlStroops: string;
  velocityStroopsPerSecond: string;
  peakStreams: number;
}

export interface HistoricalSeries {
  source: "timescaledb" | "live";
  period: AnalyticsPeriod;
  interval: AnalyticsInterval;
  points: HistoricalPoint[];
}

export interface DefiLlamaResponse {
  /** DefiLlama adapter protocol identifier. */
  id: string;
  name: string;
  /** TVL keyed by token address, plus a `total` entry — stroops. */
  tvl: Record<string, number>;
  timestamp: string;
}

/** Detects whether the TimescaleDB hypertable exists and is queryable. */
let timescaleAvailable: boolean | undefined;

/**
 * Clears the availability cache. Exported for tests: the service process
 * should cache once, but each test needs a fresh probe.
 */
export function resetTimescaleCacheForTests(): void {
  timescaleAvailable = undefined;
}

async function hasTimescale(): Promise<boolean> {
  if (timescaleAvailable !== undefined) return timescaleAvailable;
  try {
    const result = await pool.query(
      `SELECT to_regclass('public.stream_flow_snapshots') AS hypertable`
    );
    timescaleAvailable = result.rows[0]?.hypertable !== null;
  } catch (error) {
    logger.warn(
      "TimescaleDB analytics tables unavailable; using live aggregation:",
      error
    );
    timescaleAvailable = false;
  }
  return timescaleAvailable;
}

/**
 * Live fallback: aggregate active streams straight from Prisma.
 *
 * Amount columns are i128-preserved strings in the schema, so Prisma's
 * `_sum` aggregation does not apply to them; rows are summed in JS with
 * `BigInt` instead to keep the full precision end to end.
 */
async function liveTvl(): Promise<TvlSnapshot> {
  const streams = await prisma.stream.findMany({
    where: { isActive: true },
    select: {
      tokenAddress: true,
      depositedAmount: true,
      withdrawnAmount: true,
      ratePerSecond: true,
    },
  });

  const byToken = new Map<
    string,
    { locked: bigint; velocity: bigint; count: number }
  >();
  for (const stream of streams) {
    const deposited = BigInt(stream.depositedAmount);
    const withdrawn = BigInt(stream.withdrawnAmount);
    const entry = byToken.get(stream.tokenAddress) ?? {
      locked: 0n,
      velocity: 0n,
      count: 0,
    };
    entry.locked += deposited > withdrawn ? deposited - withdrawn : 0n;
    entry.velocity += BigInt(stream.ratePerSecond);
    entry.count += 1;
    byToken.set(stream.tokenAddress, entry);
  }

  const tokens: TokenTvl[] = [...byToken.entries()].map(
    ([tokenAddress, agg]) => ({
      tokenAddress,
      totalLockedStroops: agg.locked.toString(),
      velocityPerSecondStroops: agg.velocity.toString(),
      activeStreamCount: agg.count,
    })
  );

  const totalTvlStroops = tokens
    .reduce((acc, t) => acc + BigInt(t.totalLockedStroops), 0n)
    .toString();

  return {
    source: "live",
    tokens,
    totalTvlStroops,
    generatedAt: new Date().toISOString(),
  };
}

/** Latest snapshot row per token, straight from the hypertable. */
async function timescaleTvl(): Promise<TvlSnapshot> {
  const result = await pool.query(
    `SELECT DISTINCT ON (token_address)
            token_address,
            total_locked_amount,
            flow_velocity_per_second,
            active_stream_count
       FROM stream_flow_snapshots
      ORDER BY token_address, time DESC`
  );

  const snapshotRows = result.rows as {
    token_address: string;
    total_locked_amount: string;
    flow_velocity_per_second: string;
    active_stream_count: number;
  }[];

  const tokens: TokenTvl[] = snapshotRows.map((row) => ({
    tokenAddress: row.token_address,
    totalLockedStroops: BigInt(row.total_locked_amount).toString(),
    velocityPerSecondStroops: BigInt(row.flow_velocity_per_second).toString(),
    activeStreamCount: row.active_stream_count,
  }));

  const totalTvlStroops = tokens
    .reduce((acc, t) => acc + BigInt(t.totalLockedStroops), 0n)
    .toString();

  return {
    source: "timescaledb",
    tokens,
    totalTvlStroops,
    generatedAt: new Date().toISOString(),
  };
}

/** Current protocol TVL partitioned by token (#1480). */
export async function getProtocolTvl(): Promise<TvlSnapshot> {
  if (await hasTimescale()) {
    try {
      return await timescaleTvl();
    } catch (error) {
      logger.warn(
        "Timescale TVL query failed; falling back to live aggregation:",
        error
      );
    }
  }
  return liveTvl();
}

/** Historical pre-aggregated TVL/velocity series for charts (#1480). */
export async function getHistoricalAnalytics(
  period: AnalyticsPeriod,
  interval: AnalyticsInterval
): Promise<HistoricalSeries> {
  if (!(await hasTimescale())) {
    return { source: "live", period, interval, points: [] };
  }

  const view =
    interval === "1d" ? "daily_protocol_metrics" : "hourly_protocol_metrics";
  const days = PERIOD_DAYS[period];

  const result = await pool.query(
    `SELECT bucket, token_address, avg_tvl, aggregate_velocity, peak_streams
       FROM ${view}
      WHERE bucket >= now() - ($1 || ' days')::interval
      ORDER BY bucket, token_address`,
    [String(days)]
  );

  const seriesRows = result.rows as {
    bucket: Date;
    token_address: string;
    avg_tvl: string;
    aggregate_velocity: string;
    peak_streams: number;
  }[];

  return {
    source: "timescaledb",
    period,
    interval,
    points: seriesRows.map((row) => ({
      bucket: new Date(row.bucket).toISOString(),
      tokenAddress: row.token_address,
      avgTvlStroops: BigInt(row.avg_tvl).toString(),
      velocityStroopsPerSecond: BigInt(row.aggregate_velocity).toString(),
      peakStreams: row.peak_streams,
    })),
  };
}

/**
 * DefiLlama-compatible adapter payload (#1480).
 *
 * DefiLlama reads a flat `{ [chainOrToken]: tvlNumber }` shape; numbers are
 * whole units of each token's smallest display unit (stroops for Stellar).
 */
export async function getDefiLlamaAdapter(): Promise<DefiLlamaResponse> {
  const snapshot = await getProtocolTvl();
  const tvl: Record<string, number> = { total: Number(snapshot.totalTvlStroops) };
  for (const token of snapshot.tokens) {
    tvl[token.tokenAddress] = Number(token.totalLockedStroops);
  }
  return {
    id: "flowfi",
    name: "FlowFi",
    tvl,
    timestamp: snapshot.generatedAt,
  };
}
