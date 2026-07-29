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

  it('createPgPoolConfig reflects an overridden DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/test_db');

    const { createPgPoolConfig } = await import('../src/lib/pg-pool.js');

    expect(createPgPoolConfig().connectionString).toBe(
      'postgresql://test:test@localhost:5432/test_db',
    );
  });

  it('createPgPool constructs pg.Pool with the configured DATABASE_URL without opening a real connection', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@localhost:5432/test_db');

    const { createPgPool } = await import('../src/lib/pg-pool.js');
    createPgPool();

    expect(poolCtorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgresql://test:test@localhost:5432/test_db',
      }),
    );
  });
});
