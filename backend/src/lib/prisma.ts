import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/index.js';
import { createPgPool } from './pg-pool.js';

const globalForPrisma = global as unknown as {
  prisma?: PrismaClient;
  pool?: pg.Pool;
};

if (!globalForPrisma.pool) {
  globalForPrisma.pool = createPgPool();
}

// The npm workspace hoists `pg`, while the standalone Docker build resolves the
// adapter's own nested copy, so the two `Pool` types differ nominally even
// though the runtime value is one and the same `pg.Pool` instance.
type PrismaPgPool = ConstructorParameters<typeof PrismaPg>[0];

const adapter = new PrismaPg(globalForPrisma.pool as unknown as PrismaPgPool);

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export { getPoolMetrics } from './pg-pool.js';
export const pool = globalForPrisma.pool!;

export default prisma;
