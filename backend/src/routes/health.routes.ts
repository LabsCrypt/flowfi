import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { INDEXER_STATE_ID } from '../lib/indexer-state.js';
import { setIndexerLedgers } from '../lib/metrics.js';
import { isRedisAvailable } from '../lib/redis.js';
import { checkRpcHealth } from '../services/sorobanService.js';
import { sorobanEventWorker } from '../workers/soroban-event-worker.js';

const router = Router();

interface CachedHealth {
  status: number;
  body: unknown;
  expiresAt: number;
}
let _healthCache: CachedHealth | null = null;
// 2s cache (issue #1511). Disabled under NODE_ENV=test unless HEALTH_CACHE_MS is set.
const HEALTH_CACHE_MS = Number(
  process.env.HEALTH_CACHE_MS ?? (process.env.NODE_ENV === 'test' ? 0 : 2_000),
);

/** Clears the cached health result (used by tests). */
export function resetHealthCache(): void {
  _healthCache = null;
}

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
 *       is stale (lag > 60 s), or when recent event-processing failures spike.
 *       Response is cached in-memory for 2 s so consecutive rapid requests do
 *       not re-execute the DB and Redis probes (issue #1511).
 *     responses:
 *       200: { description: Service is healthy }
 *       503: { description: Service is degraded or unhealthy }
 *       429: { description: Rate limited }
 */
router.get('/', async (_req: Request, res: Response) => {
  if (_healthCache && _healthCache.expiresAt > Date.now()) {
    res.status(_healthCache.status).json(_healthCache.body);
    return;
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

  // Two independent indexer failure signals:
  //   - lag:     the durable state row has not been touched recently
  //   - failure: the worker saw a spike in per-event processing failures
  // Either one means the indexer is not keeping up, so both feed readiness.
  const eventCounters = indexerEnabled ? sorobanEventWorker.getEventCounters() : null;
  const indexerLagDegraded = indexerEnabled && indexerLag > 60;
  const indexerFailureDegraded = indexerEnabled && (eventCounters?.degraded ?? false);
  // The top-level `indexerDegraded` reports the failure-rate signal only;
  // lag is reported separately so a lag-only incident (#1294) is
  // distinguishable from a genuinely failing indexer (#844).
  const indexerDegraded = indexerFailureDegraded;

  const isHealthy =
    dbStatus === 'connected' && !(indexerLagDegraded || indexerFailureDegraded);
  // 503 only when: DB is down, OR the indexer is enabled and its state row is
  // stale (lag > 60). A missing state row (lag === -1) is a cold-start
  // condition, not a failure, even when the indexer is enabled.
  const eventCounters = sorobanEventWorker.getEventCounters();

  // 503 when: DB is down, OR the indexer is enabled and its state row is stale
  // (lag > 60), OR recent event-processing failures are spiking. A missing state
  // row (lag === -1) is a cold-start condition, not a failure.
  const indexerLagDegraded = indexerEnabled && indexerLag > 60;
  const indexerFailureDegraded = indexerEnabled && eventCounters.degraded;
  const isHealthy =
    dbStatus === 'connected' && !indexerLagDegraded && !indexerFailureDegraded;
  const status = isHealthy ? 'ok' : 'degraded';

  // Redis is optional, so its status never affects the top-level verdict.
  const redisConfigured = !!process.env.REDIS_URL;
  const redisStatus = !redisConfigured
    ? 'not_configured'
    : isRedisAvailable()
      ? 'ok'
      : 'unavailable';

  // RPC reachability is observability only; it does not gate liveness.
  const sorobanRpcOk = await checkRpcHealth();

  setIndexerLedgers(state?.lastLedger ?? 0, networkLedger);

  const responseBody = {
    status,
    db: dbStatus,
    indexerEnabled,
    indexerLag: indexerLag === -1 ? null : indexerLag,
    eventsProcessed: eventCounters?.eventsProcessed ?? 0,
    eventsFailed: eventCounters?.eventsFailed ?? 0,
    lastErrorAt: eventCounters?.lastErrorAt ?? null,
    indexerDegraded,
    eventsProcessed: eventCounters.eventsProcessed,
    eventsFailed: eventCounters.eventsFailed,
    lastErrorAt: eventCounters.lastErrorAt,
    indexerDegraded: eventCounters.degraded,
    indexerLedgerLag:
      networkLedger > 0 ? Math.max(0, networkLedger - (state?.lastLedger ?? 0)) : null,
    uptime: process.uptime(),
    checks: {
      database: { status: dbStatus === 'connected' ? 'ok' : 'down' },
      indexer: {
        status: !indexerEnabled
          ? 'disabled'
          : indexerLagDegraded || indexerFailureDegraded
          : indexerFailureDegraded || indexerLagDegraded
            ? 'degraded'
            : 'ok',
        enabled: indexerEnabled,
        lagSeconds: indexerLag === -1 ? null : indexerLag,
        lagDegraded: indexerLagDegraded,
        failureDegraded: indexerFailureDegraded,
      },
      // Redis and the Soroban RPC are optional for serving reads, so they are
      // reported for observability but deliberately excluded from readiness.
      redis: {
        status: 'unknown',
      },
      sorobanRpc: {
        status: 'unknown',
      },
      redis: { status: redisStatus },
      sorobanRpc: { status: sorobanRpcOk ? 'ok' : 'down' },
    },
  };

  const httpStatus = isHealthy ? 200 : 503;
  if (HEALTH_CACHE_MS > 0) {
    _healthCache = { status: httpStatus, body: responseBody, expiresAt: Date.now() + HEALTH_CACHE_MS };
  }
  res.status(httpStatus).json(responseBody);
});

export default router;