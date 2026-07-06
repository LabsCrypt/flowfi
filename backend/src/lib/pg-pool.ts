import pg from 'pg';

const parsePositiveIntegerEnv = (name: string, defaultValue: number): number => {
  const rawValue = process.env[name];

  if (!rawValue) return defaultValue;

  const parsedValue = Number.parseInt(rawValue, 10);

  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : defaultValue;
};

export const createPgPoolConfig = (): pg.PoolConfig => ({
  connectionString: process.env.DATABASE_URL,
  max: parsePositiveIntegerEnv('PG_POOL_MAX', 10),
  idleTimeoutMillis: parsePositiveIntegerEnv('PG_IDLE_TIMEOUT_MS', 30_000),
  connectionTimeoutMillis: parsePositiveIntegerEnv('PG_CONNECTION_TIMEOUT_MS', 5_000),
  statement_timeout: parsePositiveIntegerEnv('PG_STATEMENT_TIMEOUT_MS', 30_000),
});

export const createPgPool = () => new pg.Pool(createPgPoolConfig());
