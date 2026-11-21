import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  ctorSpy: vi.fn(),
  instances: [] as Array<Record<string, unknown>>,
}));

vi.mock('pg', () => ({
  default: {
    Pool: class {
      totalCount = 0;
      idleCount = 0;
      waitingCount = 0;
      options: Record<string, unknown>;

      constructor(config: Record<string, unknown>) {
        h.ctorSpy(config);
        this.options = config;
        h.instances.push(this as unknown as Record<string, unknown>);
      }
    },
  },
}));

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const metrics = vi.hoisted(() => ({
  dbPoolConnections: { set: vi.fn() },
  dbPoolMaxConnections: { set: vi.fn() },
  dbQueryDuration: { observe: vi.fn() },
  registerDbPoolStatsProvider: vi.fn(),
}));

vi.mock('../src/lib/metrics.js', () => metrics);

import type { Pool, PoolConfig } from 'pg';
import {
  createPgPoolConfig,
  createPgPool,
  drainPgPool,
  getPoolMetrics,
  instrumentPoolQueryTiming,
  labelForQuery,
  publishPoolMetrics,
} from '../src/lib/pg-pool.js';

function poolLike(overrides: Record<string, unknown> = {}): Pool {
  return { totalCount: 4, idleCount: 3, waitingCount: 1, options: { max: 20 }, ...overrides } as unknown as Pool;
}

describe('pg pool configuration boundaries (#1750)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    h.instances.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it.each([
    ['3.9', 3],
    ['7abc', 7],
    [' 8', 8],
    ['99999999999999999999', 1e20],
  ] as const)('parses PG_POOL_MAX=%j with radix-10 integer parsing', (rawValue, expected) => {
    vi.stubEnv('PG_POOL_MAX', rawValue);

    expect(createPgPoolConfig().max).toBe(expected);
  });

  it.each([['0'], ['-1'], [''], ['0x10'], ['NaN']])('falls back to 20 for the rejected PG_POOL_MAX=%s', (rawValue) => {
    vi.stubEnv('PG_POOL_MAX', rawValue);

    expect(createPgPoolConfig().max).toBe(20);
  });

  it('applies explicit overrides without running them through the env validator', () => {
    const config = createPgPoolConfig({ max: 0, statement_timeout: -1 } as Partial<PoolConfig>);

    expect(config.max).toBe(0);
    expect(config.statement_timeout).toBe(-1);
  });

  it('reads DATABASE_URL at call time rather than at import time', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://a:b@h1:5432/first');
    expect(createPgPoolConfig().connectionString).toBe('postgresql://a:b@h1:5432/first');

    vi.stubEnv('DATABASE_URL', 'postgresql://c:d@h2:5432/second');
    expect(createPgPoolConfig().connectionString).toBe('postgresql://c:d@h2:5432/second');
  });

  it('builds the pool from the validated config plus overrides', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@h/db');
    vi.stubEnv('PG_POOL_MAX', 'abc');

    createPgPool({ idleTimeoutMillis: 1 });

    expect(h.ctorSpy).toHaveBeenCalledWith({
      connectionString: 'postgresql://u:p@h/db',
      max: 20,
      idleTimeoutMillis: 1,
      connectionTimeoutMillis: 2_000,
      statement_timeout: 30_000,
    });
  });
});

describe('pg pool query instrumentation (#1750)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['SELECT amount FROM streams WHERE id = $1', 'SELECT:streams'],
    ['INSERT INTO users (id) VALUES ($1)', 'INSERT:users'],
    ['UPDATE streams SET x = 1', 'UPDATE:streams'],
    ['DELETE FROM streams', 'DELETE:streams'],
    ['SELECT 1', 'SELECT'],
    ['1SELECT', 'OTHER'],
    ['1SELECT FROM streams', 'OTHER:streams'],
    ['   select count(*) from streams  ', 'SELECT:streams'],
  ] as const)('labels %j as %j', (text, expected) => {
    expect(labelForQuery(text)).toBe(expected);
  });

  it('observes a successful query under its operation label', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = poolLike({ query });

    instrumentPoolQueryTiming(pool);
    await (pool as any).query('SELECT amount FROM streams WHERE id = $1', [1]);

    expect(metrics.dbQueryDuration.observe).toHaveBeenCalledWith(
      { operation: 'SELECT:streams' },
      expect.any(Number),
    );
  });

  it('accepts the object query form and still labels by verb and table', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = poolLike({ query });

    instrumentPoolQueryTiming(pool);
    await (pool as any).query({ text: 'UPDATE streams SET withdrawn = $1', values: [2] });

    expect(metrics.dbQueryDuration.observe).toHaveBeenCalledWith({ operation: 'UPDATE:streams' }, expect.any(Number));
  });

  it('observes and rethrows an asynchronous query failure', async () => {
    const failure = new Error('server closed the connection unexpectedly');
    const pool = poolLike({ query: vi.fn().mockRejectedValue(failure) });

    instrumentPoolQueryTiming(pool);

    await expect((pool as any).query('SELECT * FROM streams')).rejects.toBe(failure);
    expect(metrics.dbQueryDuration.observe).toHaveBeenCalledTimes(1);
  });

  it('observes and rethrows a synchronous query failure', () => {
    const failure = new Error('callback called twice');
    const pool = poolLike({
      query: vi.fn(() => {
        throw failure;
      }),
    });

    instrumentPoolQueryTiming(pool);

    expect(() => (pool as any).query('SELECT * FROM streams')).toThrow(failure);
    expect(metrics.dbQueryDuration.observe).toHaveBeenCalledTimes(1);
  });

  it('leaves a pool without a query method untouched', () => {
    const pool = poolLike({ query: undefined });

    expect(() => instrumentPoolQueryTiming(pool)).not.toThrow();
    expect((pool as { query?: unknown }).query).toBeUndefined();
    expect(metrics.dbQueryDuration.observe).not.toHaveBeenCalled();
  });

  it('returns zeroed counts for a pool that never reported statistics', () => {
    expect(getPoolMetrics({} as Pool)).toEqual({ totalCount: 0, idleCount: 0, waitingCount: 0 });
  });

  it('publishes one series per pool state plus the configured ceiling', () => {
    publishPoolMetrics(poolLike({ options: { max: 25 } }));

    expect(metrics.dbPoolConnections.set).toHaveBeenNthCalledWith(1, { state: 'total' }, 4);
    expect(metrics.dbPoolConnections.set).toHaveBeenNthCalledWith(2, { state: 'idle' }, 3);
    expect(metrics.dbPoolConnections.set).toHaveBeenNthCalledWith(3, { state: 'waiting' }, 1);
    expect(metrics.dbPoolMaxConnections.set).toHaveBeenCalledWith(25);
  });

  it('publishes zeros when the pool has neither counts nor options', () => {
    publishPoolMetrics({} as Pool);

    expect(metrics.dbPoolConnections.set).toHaveBeenNthCalledWith(1, { state: 'total' }, 0);
    expect(metrics.dbPoolMaxConnections.set).toHaveBeenCalledWith(0);
  });
});

describe('pg pool lifecycle (#1750)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    h.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('samples the live counts on the default five second interval', async () => {
    createPgPool();

    const publishedAfterInit = metrics.dbPoolConnections.set.mock.calls.length;
    expect(publishedAfterInit).toBe(3);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(metrics.dbPoolConnections.set.mock.calls.length).toBe(publishedAfterInit);

    await vi.advanceTimersByTimeAsync(1);
    expect(metrics.dbPoolConnections.set.mock.calls.length).toBe(publishedAfterInit + 3);
  });

  it('reads PG_POOL_METRICS_INTERVAL_MS at module load and honours it', async () => {
    vi.stubEnv('PG_POOL_METRICS_INTERVAL_MS', '1000');
    vi.resetModules();
    const reloaded = await import('../src/lib/pg-pool.js');

    reloaded.createPgPool();

    const publishedAfterInit = metrics.dbPoolConnections.set.mock.calls.length;
    expect(publishedAfterInit).toBe(3);

    await vi.advanceTimersByTimeAsync(999);
    expect(metrics.dbPoolConnections.set.mock.calls.length).toBe(publishedAfterInit);

    await vi.advanceTimersByTimeAsync(1);
    expect(metrics.dbPoolConnections.set.mock.calls.length).toBe(publishedAfterInit + 3);

    // A 1s cadence, not the 5s default: two more ticks in the next two seconds.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(metrics.dbPoolConnections.set.mock.calls.length).toBe(publishedAfterInit + 9);
  });

  it('registers a scrape-time provider that reads the pool it created', () => {
    createPgPool({ max: 7 } as Partial<PoolConfig>);

    expect(metrics.registerDbPoolStatsProvider).toHaveBeenCalledTimes(1);

    const provider = metrics.registerDbPoolStatsProvider.mock.calls[0]![0] as () => {
      total: number;
      idle: number;
      waiting: number;
    };
    const sampled = provider();

    expect(sampled).toEqual({ total: 0, idle: 0, waiting: 0 });
    expect(h.instances).toHaveLength(1);
  });

  it('builds a new pool for every call instead of reusing a singleton', () => {
    const first = createPgPool();
    const second = createPgPool();

    expect(first).not.toBe(second);
    expect(metrics.registerDbPoolStatsProvider).toHaveBeenCalledTimes(2);
    expect(h.instances).toHaveLength(2);
  });

  it('rejects a healthy pool when the drain budget is zero and end settles later', async () => {
    const pool = {
      end: () => new Promise<void>((resolve) => setTimeout(resolve, 1)),
    } as unknown as Pool;

    const drained = drainPgPool(pool, { timeoutMs: 0 });
    const outcome = expect(drained).rejects.toThrow('pg pool drain timed out after 0ms');

    await vi.advanceTimersByTimeAsync(0);
    await outcome;
    await vi.advanceTimersByTimeAsync(1);
  });

  it('rejects a pool that cannot end at all', async () => {
    const drained = drainPgPool({} as unknown as Pool, { timeoutMs: 1_000 });

    await expect(drained).rejects.toThrow(TypeError);
    await vi.advanceTimersByTimeAsync(1_000);
  });
});
