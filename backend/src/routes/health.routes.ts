import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { INDEXER_STATE_ID } from '../lib/indexer-state.js';
import { setIndexerLedgers } from '../lib/metrics.js';

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
 *     responses:
 *       200:
 *         description: Service is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 *                 db:
 *                   type: string
 *                   example: connected
 *                 indexerEnabled:
 *                   type: boolean
 *                   description: Whether the event indexer is configured
 *                   example: true
 *                 indexerLag:
 *                   type: integer
 *                   nullable: true
 *                   description: Seconds since last indexer update, or null when no state row exists yet
 *                   example: 5
 *                 uptime:
 *                   type: number
 *                   description: Server uptime in seconds
 *                   example: 3600
 *       503:
 *         description: Service is degraded or unhealthy
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

  // 503 only when: DB is down, OR the indexer is enabled and its state row is
  // stale (lag > 60). A missing state row (lag === -1) is a cold-start
  // condition, not a failure, even when the indexer is enabled.
  const indexerDegraded = indexerEnabled && indexerLag > 60;
  const isHealthy = dbStatus === 'connected' && !indexerDegraded;
  const status = isHealthy ? 'ok' : 'degraded';

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
  });
});

export default router;
