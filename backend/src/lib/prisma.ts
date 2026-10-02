import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/index.js';
import { createPgPool, getPoolMetrics } from './pg-pool.js';

const globalForPrisma = global as unknown as {
  prisma?: PrismaClient;
  pool?: pg.Pool;
};

if (!globalForPrisma.pool) {
  globalForPrisma.pool = createPgPool();
}

// PrismaPg accepts a pg.Pool directly, but `@types/pg` can resolve to two
// different copies in this tree — the hoisted one and the older one nested
// under `@opentelemetry/instrumentation-pg`. Which copy `@prisma/adapter-pg`
// picks depends on how npm hoisted them, and under `exactOptionalPropertyTypes`
// the two `Pool` classes are not mutually assignable, so this line fails to
// compile in some install layouts (CI's Docker build included) while passing
// in others. The mismatch is type-only: the adapter duck-types the pool it is
// handed, so cast through the adapter's own constructor signature instead of
// depending on both copies being identical.
const adapter = new PrismaPg(
  globalForPrisma.pool as unknown as ConstructorParameters<typeof PrismaPg>[0],
);

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export { getPoolMetrics };
export const pool = globalForPrisma.pool!;

export default prisma;
