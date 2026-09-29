import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { INDEXER_STATE_ID } from '../lib/indexer-state.js';
import { setIndexerLedgers } from '../lib/metrics.js';
import { isRedisAvailable } from '../lib/redis.js';

const router = Router();

interface CachedHealth {
  status: number;
  body: unknown;
  expiresAt: number;
}
let _healthCache: CachedHealth | null = null;
const HEALTH_CACHE_MS = 2_000;

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Detailed health check
 *     description: |
 *       Returns liveness and readiness information. Liveness (200 vs 503) is
 *       determined by DB reachability alone. Indexer lag is reported in the
 *       body for observability but only forces a 503 when the indexer is
 *       actually enabled (`STREAM_CONTRACT_ID` env var set) and its state row
 *       is stale (lag > 60 s). Response is cached in-memory for 2 s so
 *       consecutive rapid requests do not re-execute the DB and Redis probes
 *       (issue #1511).
 *     responses:
 *       200: { description: Service is healthy }
 *       503: { description: Service is degraded or unhealthy }
 *       429: { description: Rate limited }
 */
router.get('/', async (_req: Request, res: Response) => {
  const now = Date.now();
  if (_healthCache && _healthCache.expiresAt > now) {
    return res.status(_healthCache.status).json(_healthCache.body);
  }

  let dbStatus = 'connected';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbStatus = 'disconnected';
  }

  const indexerEnabled = !!process.env.STREAM_CONTRACT_ID;

  let indexerLag = -1;
  let state: Awaited<ReturnType<typeof prisma.indexerState.findUnique>> = null;
  try {
    state = await prisma.indexerState.findUnique({ where: { id: INDEXER_STATE_ID } });
    if (state) {
      const nowSec = Math.floor(Date.now() / 1000);
      const updatedAt = Math.floor(state.updatedAt.getTime() / 1000);
      indexerLag = Math.max(0, nowSec - updatedAt);
    }
  } catch {
    indexerLag = -1;
  }

  let networkLedger = 0;
  if (indexerEnabled) {
    try {
      const { getLatestLedger } = await import('../services/sorobanService.js');
      networkLedger = await getLatestLedger();
    } catch {
      networkLedger = 0;
    }
  }

  const indexerLagDegraded = indexerEnabled && indexerLag > 60;
  const indexerFailureDegraded = false;
  const isHealthy = dbStatus === 'connected' && !indexerLagDegraded;
  const status = isHealthy ? 'ok' : 'degraded';

  const redisStatus = isRedisAvailable() ? 'ok' : 'disabled';
  const sorobanRpcOk = !indexerEnabled || networkLedger > 0;

  setIndexerLedgers(state?.lastLedger ?? 0, networkLedger);

  const responseBody = {
    status,
    db: dbStatus,
    indexerEnabled,
    indexerLag: indexerLag === -1 ? null : indexerLag,
    indexerLedgerLag:
      networkLedger > 0 ? Math.max(0, networkLedger - (state?.lastLedger ?? 0)) : null,
    uptime: process.uptime(),
    checks: {
      database: { status: dbStatus === 'connected' ? 'ok' : 'down' },
      indexer: {
        status: !indexerEnabled
          ? 'disabled'
          : indexerFailureDegraded || indexerLagDegraded
            ? 'degraded'
            : 'ok',
        enabled: indexerEnabled,
        lagSeconds: indexerLag === -1 ? null : indexerLag,
      },
      redis: { status: redisStatus },
      sorobanRpc: { status: sorobanRpcOk ? 'ok' : 'down' },
    },
  };

  const httpStatus = isHealthy ? 200 : 503;
  _healthCache = { status: httpStatus, body: responseBody, expiresAt: Date.now() + HEALTH_CACHE_MS };
  return res.status(httpStatus).json(responseBody);
});

export default router;