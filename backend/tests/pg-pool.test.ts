import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const poolCtorSpy = vi.fn();

vi.mock('pg', () => ({
  default: {
    Pool: class {
      constructor(config: unknown) {
        poolCtorSpy(config);
      }
    },
  },
}));

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('pg-pool', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    poolCtorSpy.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('createPgPoolConfig returns sane default pool settings when env vars are unset', async () => {
    const { createPgPoolConfig } = await import('../src/lib/pg-pool.js');
    const config = createPgPoolConfig();

    expect(config.max).toBe(10);
    expect(config.idleTimeoutMillis).toBe(30_000);
    expect(config.connectionTimeoutMillis).toBe(5_000);
    expect(config.statement_timeout).toBe(30_000);
  });

  it('createPgPoolConfig reflects custom env variable overrides', async () => {
    vi.stubEnv('PG_POOL_MAX', '25');
    vi.stubEnv('PG_IDLE_TIMEOUT_MS', '60000');
    vi.stubEnv('PG_CONNECTION_TIMEOUT_MS', '10000');
    vi.stubEnv('PG_STATEMENT_TIMEOUT_MS', '15000');

    const { createPgPoolConfig } = await import('../src/lib/pg-pool.js');
    const config = createPgPoolConfig();

    expect(config.max).toBe(25);
    expect(config.idleTimeoutMillis).toBe(60_000);
    expect(config.connectionTimeoutMillis).toBe(10_000);
    expect(config.statement_timeout).toBe(15_000);
  });

  it('createPgPoolConfig falls back to defaults when env variables are invalid or non-positive', async () => {
    vi.stubEnv('PG_POOL_MAX', 'invalid_number');
    vi.stubEnv('PG_IDLE_TIMEOUT_MS', '-5000');
    vi.stubEnv('PG_CONNECTION_TIMEOUT_MS', '0');
    vi.stubEnv('PG_STATEMENT_TIMEOUT_MS', 'abc');

    const { createPgPoolConfig } = await import('../src/lib/pg-pool.js');
    const config = createPgPoolConfig();

    expect(config.max).toBe(10);
    expect(config.idleTimeoutMillis).toBe(30_000);
    expect(config.connectionTimeoutMillis).toBe(5_000);
    expect(config.statement_timeout).toBe(30_000);
  });

  it('createPgPool constructs pg.Pool with default pool configuration settings', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/test_db');

    const { createPgPool } = await import('../src/lib/pg-pool.js');
    createPgPool();

    expect(poolCtorSpy).toHaveBeenCalledWith({
      connectionString: 'postgresql://test:test@localhost:5432/test_db',
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
    });
  });

  it('createPgPool applies config overrides when provided', async () => {
    const { createPgPool } = await import('../src/lib/pg-pool.js');
    createPgPool({ max: 5, statement_timeout: 5000 });

    expect(poolCtorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        max: 5,
        statement_timeout: 5000,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      }),
    );
  });

  it('getPoolMetrics returns totalCount, idleCount, and waitingCount from the pool', async () => {
    const { getPoolMetrics } = await import('../src/lib/pg-pool.js');

    const mockPool = {
      totalCount: 10,
      idleCount: 5,
      waitingCount: 2,
    } as any;

    const metrics = getPoolMetrics(mockPool);

    expect(metrics).toEqual({
      totalCount: 10,
      idleCount: 5,
      waitingCount: 2,
    });
  });

  describe('drainPgPool', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const makeMockPool = (endImpl: () => Promise<void>) => ({ end: endImpl }) as unknown as import('pg').Pool;

    it('logs that the pool is being drained and resolves when end() succeeds', async () => {
      const { drainPgPool } = await import('../src/lib/pg-pool.js');
      const logger = (await import('../src/logger.js')).default as { info: ReturnType<typeof vi.fn> };
      const endSpy = vi.fn().mockResolvedValue(undefined);
      const pool = makeMockPool(endSpy);

      const drained = drainPgPool(pool);

      expect(logger.info).toHaveBeenCalledWith('Draining database pool...');
      await drained;
      expect(endSpy).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith('Database pool drained.');
    });

    it('waits for in-flight queries to flush before resolving', async () => {
      const { drainPgPool } = await import('../src/lib/pg-pool.js');
      const logger = (await import('../src/logger.js')).default as { info: ReturnType<typeof vi.fn> };
      let releaseQuery!: () => void;
      const inFlightQuery = new Promise<void>((resolve) => {
        releaseQuery = resolve;
      });
      let ended = false;
      const endSpy = vi.fn(async () => {
        await inFlightQuery;
        ended = true;
      });
      const pool = makeMockPool(endSpy);

      const drained = drainPgPool(pool);
      const settled = vi.fn();
      void drained.then(settled, settled);

      // Let microtasks run without releasing the in-flight query.
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).not.toHaveBeenCalled();
      expect(ended).toBe(false);

      releaseQuery();
      await vi.advanceTimersByTimeAsync(0);
      await drained;
      expect(ended).toBe(true);
      expect(logger.info).toHaveBeenCalledWith('Database pool drained.');
    });

    it('rejects when end() does not settle within the timeout budget', async () => {
      const { drainPgPool } = await import('../src/lib/pg-pool.js');
      const endSpy = vi.fn(() => new Promise<void>(() => {})); // never settles
      const pool = makeMockPool(endSpy);

      const drained = drainPgPool(pool, { timeoutMs: 1_000 });

      // Fire the timeout, then observe the rejection on the drain promise.
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(drained).rejects.toThrow('pg pool drain timed out after 1000ms');
    });

    it('defaults the timeout to PG_POOL_DRAIN_TIMEOUT_MS or 30s', async () => {
      const { drainPgPool } = await import('../src/lib/pg-pool.js');
      const endSpy = vi.fn(() => new Promise<void>(() => {})); // never settles
      const pool = makeMockPool(endSpy);

      const drained = drainPgPool(pool);

      // Still pending just before the 30s default deadline.
      await vi.advanceTimersByTimeAsync(29_999);
      await expect(Promise.race([drained, Promise.resolve('pending')])).resolves.toBe('pending');

      await vi.advanceTimersByTimeAsync(1);
      await expect(drained).rejects.toThrow('pg pool drain timed out after 30000ms');
    });

    it('rejects when pool.end() itself fails', async () => {
      const { drainPgPool } = await import('../src/lib/pg-pool.js');
      const endSpy = vi.fn().mockRejectedValue(new Error('end failed'));
      const pool = makeMockPool(endSpy);

      await expect(drainPgPool(pool)).rejects.toThrow('end failed');
    });

    it('respects a custom PG_POOL_DRAIN_TIMEOUT_MS environment override', async () => {
      vi.stubEnv('PG_POOL_DRAIN_TIMEOUT_MS', '250');
      const { drainPgPool } = await import('../src/lib/pg-pool.js');
      const endSpy = vi.fn(() => new Promise<void>(() => {})); // never settles
      const pool = makeMockPool(endSpy);

      const drained = drainPgPool(pool);

      await vi.advanceTimersByTimeAsync(250);
      await expect(drained).rejects.toThrow('pg pool drain timed out after 250ms');
    });
  });
});
