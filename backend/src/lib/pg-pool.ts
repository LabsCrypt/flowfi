import pg from 'pg';
import logger from '../logger.js';
import {
  dbPoolConnections,
  dbPoolMaxConnections,
  dbQueryDuration,
} from './metrics.js';

const parsePositiveIntegerEnv = (name: string, defaultValue: number): number => {
  const rawValue = process.env[name];

  if (!rawValue) return defaultValue;

  const parsedValue = Number.parseInt(rawValue, 10);

  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : defaultValue;
};

export const createPgPoolConfig = (overrides?: Partial<pg.PoolConfig>): pg.PoolConfig => ({
  connectionString: process.env.DATABASE_URL,
  max: parsePositiveIntegerEnv('PG_POOL_MAX', 10),
  idleTimeoutMillis: parsePositiveIntegerEnv('PG_IDLE_TIMEOUT_MS', 30_000),
  connectionTimeoutMillis: parsePositiveIntegerEnv('PG_CONNECTION_TIMEOUT_MS', 5_000),
  statement_timeout: parsePositiveIntegerEnv('PG_STATEMENT_TIMEOUT_MS', 30_000),
  ...overrides,
});

/**
 * Publish pool utilisation gauges.
 *
 * `waitingCount` is the number to alert on: a non-zero value means callers are
 * queued for a connection, which surfaces as request latency long before the
 * pool would be considered "full".
 */
export function publishPoolMetrics(pool: pg.Pool): void {
  dbPoolConnections.set({ state: 'total' }, pool.totalCount ?? 0);
  dbPoolConnections.set({ state: 'idle' }, pool.idleCount ?? 0);
  dbPoolConnections.set({ state: 'waiting' }, pool.waitingCount ?? 0);
  dbPoolMaxConnections.set(pool.options?.max ?? 0);
}

/**
 * Reduce a SQL statement to a low-cardinality operation label.
 *
 * Raw SQL would be a terrible Prometheus label (one series per query, ever), so
 * statements are bucketed by verb and target table.
 */
export function labelForQuery(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const verb = /^([a-z]+)/i.exec(normalized)?.[1]?.toUpperCase() ?? 'OTHER';

  const target =
    /(?:\bfrom\b|\binto\b|\bupdate\b|\btable\b)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(
      normalized,
    )?.[1] ?? '';

  return target ? `${verb}:${target}` : verb;
}

/**
 * Time every query issued through the pool.
 *
 * Prisma's driver-adapter setup does not emit query events, so the pool is the
 * only reliable measurement point — and it captures queue wait time as well as
 * execution, which is what an operator needs to attribute latency to.
 */
export function instrumentPoolQueryTiming(pool: pg.Pool): void {
  const original = pool.query?.bind(pool) as
    | ((...args: unknown[]) => unknown)
    | undefined;
  if (typeof original !== 'function') return;

  pool.query = ((...args: unknown[]) => {
    const startedAt = process.hrtime.bigint();
    const operation = labelForQuery(
      typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? ''),
    );

    const record = () => {
      dbQueryDuration.observe({ operation }, Number(process.hrtime.bigint() - startedAt) / 1e9);
    };

    let result: unknown;
    try {
      result = original(...args);
    } catch (err) {
      record();
      throw err;
    }

    if (result && typeof (result as Promise<unknown>).then === 'function') {
      return (result as Promise<unknown>).then(
        (value) => {
          record();
          return value;
        },
        (err: unknown) => {
          record();
          throw err;
        },
      );
    }

    record();
    return result;
  }) as typeof pool.query;
}

const POOL_METRICS_INTERVAL_MS = Number(
  process.env.PG_POOL_METRICS_INTERVAL_MS ?? 5_000,
);

export const createPgPool = (): pg.Pool => {
  const pool = new pg.Pool(createPgPoolConfig());

  instrumentPoolQueryTiming(pool);

  // `totalCount`/`idleCount`/`waitingCount` are mutated only by pg itself, so a
  // low-frequency sampler keeps the gauges fresh without adding per-query
  // overhead. `unref` keeps the timer from holding the process open.
  const sampler = setInterval(() => publishPoolMetrics(pool), POOL_METRICS_INTERVAL_MS);
  sampler.unref?.();

  publishPoolMetrics(pool);

  return pool;
};

export interface DrainPgPoolOptions {
  /**
   * Maximum time to wait for in-flight queries to flush before giving up.
   * Defaults to `PG_POOL_DRAIN_TIMEOUT_MS`, falling back to 30s so a wedged
   * query can never hold container teardown open indefinitely.
   */
  timeoutMs?: number;
}

/**
 * Gracefully drain a pg pool during process shutdown (SIGTERM/SIGINT).
 *
 * `pool.end()` closes every idle client immediately and waits for clients with
 * in-flight queries to finish before closing them, which prevents abruptly
 * killed containers from leaving dangling connections for Postgres to reap via
 * server-side keepalives. The wait is bounded: on timeout the promise rejects
 * and callers should still force-exit so the process cannot hang.
 *
 * Rejects (rather than swallowing) when `pool.end()` itself fails or the
 * timeout elapses, so shutdown exit codes can reflect the failure.
 */
export async function drainPgPool(pool: pg.Pool, options: DrainPgPoolOptions = {}): Promise<void> {
  const timeoutMs =
    options.timeoutMs ?? parsePositiveIntegerEnv('PG_POOL_DRAIN_TIMEOUT_MS', 30_000);

  logger.info('Draining database pool...');

  await Promise.race([
    pool.end(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`pg pool drain timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);

  logger.info('Database pool drained.');
}
