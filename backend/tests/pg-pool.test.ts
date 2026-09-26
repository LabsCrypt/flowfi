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
});
