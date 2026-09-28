import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { readReplicas } from '@prisma/extension-read-replicas';
import { PrismaClient } from '../generated/prisma/index.js';
import { createPgPool } from './pg-pool.js';

const globalForPrisma = global as unknown as {
  prisma?: PrismaClient;
  pool?: pg.Pool;
  readReplicaPool?: pg.Pool;
  readReplicaClient?: PrismaClient;
  primaryClient?: PrismaClient;
};

if (!globalForPrisma.pool) {
  globalForPrisma.pool = createPgPool();
}

const log =
  process.env.NODE_ENV === 'development'
    ? ['query', 'error', 'warn'] as const
    : ['error'] as const;
const primaryClient =
  globalForPrisma.primaryClient ||
  new PrismaClient({
    adapter: new PrismaPg(globalForPrisma.pool),
    log: [...log],
  });
globalForPrisma.primaryClient = primaryClient;
const readReplicaUrl = process.env.DATABASE_READ_REPLICA_URL?.trim();

if (readReplicaUrl && !globalForPrisma.readReplicaClient) {
  globalForPrisma.readReplicaPool = createPgPool({ connectionString: readReplicaUrl });
  globalForPrisma.readReplicaClient = new PrismaClient({
    adapter: new PrismaPg(globalForPrisma.readReplicaPool),
    log: [...log],
  });
}

const client = readReplicaUrl && globalForPrisma.readReplicaClient
  ? primaryClient.$extends(readReplicas({ replicas: [globalForPrisma.readReplicaClient] }))
  : primaryClient;

export const prisma = globalForPrisma.prisma || (client as PrismaClient);
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

const REPLICA_CONNECTION_ERROR_CODES = new Set([
  'P1001', 'P1002', 'P1017', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', '57P01', '08000', '08001', '08003',
  '08006', '08004', '08007', '08P01',
]);

function isReplicaConnectionError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const details = current as { code?: unknown; cause?: unknown; message?: unknown; meta?: unknown; driverAdapterError?: unknown };
    if (typeof details.code === 'string' && REPLICA_CONNECTION_ERROR_CODES.has(details.code)) return true;
    if (typeof details.message === 'string' && /connection (?:terminated|closed|timeout)|connect(?:ion)? refused|server closed the connection|can't reach database server|failed to connect/i.test(details.message)) return true;
    if (details.cause) pending.push(details.cause);
    if (details.meta) pending.push(details.meta);
    if (details.driverAdapterError) pending.push(details.driverAdapterError);
  }
  return false;
}

const REPLICA_FAILURE_COOLDOWN_MS = 5_000;
let replicaUnavailableUntil = 0;

/** Execute a read against the configured replica and retry connection failures on primary. */
export async function withReplicaFallback<T>(query: (client: PrismaClient) => Promise<T>): Promise<T> {
  if (!readReplicaUrl) return query(prisma);
  const primary = (prisma as PrismaClient & { $primary?: () => PrismaClient }).$primary?.();
  if (!primary) return query(prisma);
  if (Date.now() < replicaUnavailableUntil) return query(primary);
  try {
    return await query(prisma);
  } catch (error) {
    if (!isReplicaConnectionError(error)) throw error;
    replicaUnavailableUntil = Date.now() + REPLICA_FAILURE_COOLDOWN_MS;
    return query(primary);
  }
}

export { getPoolMetrics } from './pg-pool.js';
export const pool = globalForPrisma.pool!;
export default prisma;
