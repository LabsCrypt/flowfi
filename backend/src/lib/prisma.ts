import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/index.js';

const globalForPrisma = global as unknown as {
  prisma: PrismaClient;
  pool: pg.Pool;
};

const connectionString = process.env.DATABASE_URL;

if (!globalForPrisma.pool) {
  globalForPrisma.pool = new pg.Pool({ connectionString });
}

const adapter = new PrismaPg(globalForPrisma.pool);

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
