import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { INDEXER_STATE_ID } from '../lib/indexer-state.js';
import { setIndexerLedgers } from '../lib/metrics.js';
import { isRedisAvailable } from '../lib/redis.js';
import { sorobanEventWorker } from '../workers/soroban-event-worker.js';

const router = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     tags:
 *       - Health
 *     summary: Detailed health check
 *     description: |
 *       Returns liveness and readiness information.
 *       **Liveness** (200 vs 503) is determined by DB reachability alone.
 *       **Indexer lag** is reported in the body for observability but only
 *       forces a 503 when the indexer is actually enabled
 *       (`STREAM_CONTRACT_ID` env var set) and its state row is stale
 *       (lag > 60 s). A cold-started instance with no state row yet, or a
 *       deployment with the indexer intentionally disabled, always returns 200
 *       as long as the DB is reachable.
 *       **Event-processing failures** are also reported. When the indexer is
 *       enabled and recent per-event failures spike (≥50% of attempts in the
 *       last 5 minutes, with ≥3 samples), the endpoint returns 503 even if
 *       lag looks healthy (the IndexerState upsert bumps updatedAt every poll).
 *     responses:
 *       200:
 *         description: Service is healthy
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 *       503:
 *         description: Service is degraded or unhealthy
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 */
router.get('/', async (_req: Request, res: Response) => {
  let dbStatus = 'connected';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbStatus = 'disconnected';
  }

  // Whether the event-indexer is configured (STREAM_CONTRACT_ID must be set for it to run).
  const indexerEnabled = !!process.env.STREAM_CONTRACT_ID;

  let indexerLag = -1;
  let state: Awaited<ReturnType<typeof prisma.indexerState.findUnique>> = null;
  try {
    state = await prisma.indexerState.findUnique({ where: { id: INDEXER_STATE_ID } });
    if (state) {
      const now = Math.floor(Date.now() / 1000);
      const updatedAt = Math.floor(state.updatedAt.getTime() / 1000);
      indexerLag = Math.max(0, now - updatedAt);
    }
    // indexerLag === -1 means no state row yet (cold start) — not an error.
  } catch {
    indexerLag = -1;
  }

  // Resolve the network tip so ledger lag is reportable without waiting for the
  // next indexer poll. Failure is non-fatal: lag degrades to null.
  let networkLedger = 0;
  if (indexerEnabled) {
    try {
      const { getLatestLedger } = await import('../services/sorobanService.js');
      networkLedger = await getLatestLedger();
    } catch {
      networkLedger = 0;
    }
  }

  // Per-event processing failures (#844). The poll loop bumps `updatedAt` on
  // every cycle whether or not the events in it succeeded, so a spike in
  // failures is invisible to the lag check alone — it has to be read from the
  // worker's own sliding-window counters.
  const counters = sorobanEventWorker.getEventCounters();

  // Two independent reasons the indexer can be degraded: its state row is stale
  // (lag > 60), or recent event processing is failing. A missing state row
  // (lag === -1) is a cold-start condition, not a failure.
  const indexerLagDegraded = indexerEnabled && indexerLag > 60;
  const indexerFailureDegraded = indexerEnabled && counters.degraded;

  // 503 when: DB is down, OR the indexer is enabled and is degraded by either
  // signal. `indexerDegraded` in the body reports the failure-based signal
  // only, so operators can tell a lagging indexer from a broken one.
  const indexerDegraded = indexerFailureDegraded;
  const isHealthy = dbStatus === 'connected' && !indexerLagDegraded && !indexerFailureDegraded;
  const status = isHealthy ? 'ok' : 'degraded';

  // Redis is optional: without REDIS_URL the API runs in single-instance SSE
  // mode, which is a supported configuration rather than a degraded one.
  const redisStatus = !process.env.REDIS_URL ? 'disabled' : isRedisAvailable() ? 'ok' : 'down';

  // The network tip doubles as the RPC reachability signal; `getLatestLedger`
  // resolves 0 when the endpoint cannot be reached.
  const sorobanRpcOk = !indexerEnabled || networkLedger > 0;

  // Keep the Prometheus gauges in step with what /health reports, so a scrape
  // taken between poll cycles still reflects the ledger the indexer reached.
  setIndexerLedgers(state?.lastLedger ?? 0, networkLedger);

  res.status(isHealthy ? 200 : 503).json({
    status,
    db: dbStatus,
    indexerEnabled,
    indexerLag: indexerLag === -1 ? null : indexerLag,
    // Ledger-level lag, which is what `flowfi_indexer_lag_ledgers` tracks.
    // Null when the network tip could not be resolved.
    indexerLedgerLag:
      networkLedger > 0 ? Math.max(0, networkLedger - (state?.lastLedger ?? 0)) : null,
    uptime: process.uptime(),
    eventsProcessed: counters.eventsProcessed,
    eventsFailed: counters.eventsFailed,
    lastErrorAt: counters.lastErrorAt,
    indexerDegraded,
    checks: {
      database: {
        status: dbStatus === 'connected' ? 'ok' : 'down',
      },
      indexer: {
        status: !indexerEnabled
          ? 'disabled'
          : indexerFailureDegraded || indexerLagDegraded
            ? 'degraded'
            : 'ok',
        enabled: indexerEnabled,
        lagSeconds: indexerLag === -1 ? null : indexerLag,
      },
      redis: {
        status: redisStatus,
      },
      sorobanRpc: {
        status: sorobanRpcOk ? 'ok' : 'down',
      },
    },
  });
});

export default router;
