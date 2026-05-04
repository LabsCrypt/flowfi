import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAdmin } from '../../middleware/auth.js';
import {
  getIndexerStatus,
  resetIndexer,
  replayFromLedger,
} from '../../services/indexerService.js';

import { prisma } from '../../lib/prisma.js';
import { sseService } from '../../services/sse.service.js';
import { cache } from '../../lib/redis.js';
import logger from '../../logger.js';

const router = Router();

// All admin routes require admin JWT
router.use(requireAdmin);

/**
 * @openapi
 * /v1/admin/metrics:
 *   get:
 *     tags: [Admin]
 *     summary: Protocol health metrics
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Protocol health metrics
 */
const ADMIN_METRICS_CACHE_KEY = 'admin:metrics';
const ADMIN_METRICS_CACHE_TTL_SECONDS = 60;

async function buildAdminMetrics() {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    activeCount,
    pausedCount,
    totalCount,
    cancelledCount,
    completedCount,
    eventsLast24h,
    indexerState,
    feeEvents,
    feesLast24h,
    withdrawnSums,
  ] = await Promise.all([
    prisma.stream.count({ where: { isActive: true } }),
    prisma.stream.count({ where: { isPaused: true } }),
    prisma.stream.count(),
    prisma.stream.count({
      where: { isActive: false, events: { some: { eventType: 'CANCELLED' } } },
    }),
    prisma.stream.count({
      where: { isActive: false, events: { some: { eventType: 'COMPLETED' } } },
    }),
    prisma.streamEvent.count({ where: { createdAt: { gte: since24h } } }),
    prisma.indexerState.findUnique({ where: { id: 'singleton' } }),
    prisma.streamEvent.findMany({
      where: { eventType: 'FEE_COLLECTED' },
      select: { amount: true, metadata: true },
    }),
    prisma.streamEvent.findMany({
      where: { eventType: 'FEE_COLLECTED', createdAt: { gte: since24h } },
      select: { amount: true, metadata: true },
    }),
    prisma.stream.findMany({ select: { withdrawnAmount: true } }),
  ]);

  // Aggregate fees by token
  const totalFeesCollectedByToken: Record<string, string> = {};
  const feesLast24hByToken: Record<string, string> = {};

  for (const event of feeEvents) {
    const metadata = event.metadata ? JSON.parse(event.metadata) : {};
    const token = metadata.token || 'unknown';
    const amount = BigInt(event.amount || '0');
    totalFeesCollectedByToken[token] = (
      BigInt(totalFeesCollectedByToken[token] || '0') + amount
    ).toString();
  }

  for (const event of feesLast24h) {
    const metadata = event.metadata ? JSON.parse(event.metadata) : {};
    const token = metadata.token || 'unknown';
    const amount = BigInt(event.amount || '0');
    feesLast24hByToken[token] = (
      BigInt(feesLast24hByToken[token] || '0') + amount
    ).toString();
  }

  // Sum total volume streamed (sum of withdrawn amounts) as BigInt to preserve i128 precision.
  let totalVolumeStreamed = BigInt(0);
  for (const row of withdrawnSums) {
    totalVolumeStreamed += BigInt(row.withdrawnAmount || '0');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const lagSeconds = indexerState
    ? nowSec - Math.floor(indexerState.updatedAt.getTime() / 1000)
    : null;

  return {
    // Snake_case summary requested by issue #426. Exposed at the top level so
    // operators (and future dashboards) can read aggregate counts without
    // walking the nested protocol-health tree below.
    total_streams: totalCount,
    active_streams: activeCount,
    paused_streams: pausedCount,
    completed_streams: completedCount,
    cancelled_streams: cancelledCount,
    total_volume_streamed: totalVolumeStreamed.toString(),

    streams: {
      active: activeCount,
      paused: pausedCount,
      total: totalCount,
      byStatus: {
        active: activeCount,
        paused: pausedCount,
        cancelled: cancelledCount,
        completed: completedCount,
      },
    },
    events: { last24h: eventsLast24h },
    fees: {
      totalFeesCollectedByToken,
      feesLast24h: feesLast24hByToken,
    },
    sse: { activeConnections: sseService.getClientCount() },
    cache: cache.getStats(),
    indexer: {
      lastLedger: indexerState?.lastLedger ?? 0,
      lagSeconds,
      lastUpdated: indexerState?.updatedAt ?? null,
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
}

router.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const cached = cache.get<Awaited<ReturnType<typeof buildAdminMetrics>>>(
      ADMIN_METRICS_CACHE_KEY,
    );
    if (cached) {
      res.set('X-Cache', 'HIT');
      res.json(cached);
      return;
    }

    const payload = await buildAdminMetrics();
    cache.set(ADMIN_METRICS_CACHE_KEY, payload, ADMIN_METRICS_CACHE_TTL_SECONDS);
    res.set('X-Cache', 'MISS');
    res.json(payload);
  } catch (err) {
    logger.error('Error fetching admin metrics:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * @openapi
 * /v1/admin/indexer/status:
 *   get:
 *     tags: [Admin]
 *     summary: Get indexer status
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Indexer status
 */
router.get('/indexer/status', async (req: Request, res: Response) => {
  try {
    const status = await getIndexerStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch indexer status' });
  }
});

/**
 * @openapi
 * /v1/admin/indexer/reset:
 *   post:
 *     tags: [Admin]
 *     summary: Reset indexer lastProcessedLedger
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ledger]
 *             properties:
 *               ledger:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Reset successful
 */
router.post('/indexer/reset', async (req: Request, res: Response) => {
  const ledger = Number(req.body?.ledger);
  if (!Number.isInteger(ledger) || ledger < 0) {
    res.status(400).json({ error: 'ledger must be a non-negative integer' });
    return;
  }
  try {
    await resetIndexer(ledger);
    res.json({ ok: true, lastLedger: ledger });
  } catch (err) {
    res.status(500).json({ error: 'Reset failed' });
  }
});

/**
 * @openapi
 * /v1/admin/indexer/replay:
 *   post:
 *     tags: [Admin]
 *     summary: Replay events from a given ledger (idempotent)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: from_ledger
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       202:
 *         description: Replay started
 */
router.post('/indexer/replay', async (req: Request, res: Response) => {
  const fromLedger = Number(req.query.from_ledger);
  if (!Number.isInteger(fromLedger) || fromLedger < 0) {
    res.status(400).json({ error: 'from_ledger must be a non-negative integer' });
    return;
  }
  try {
    await replayFromLedger(fromLedger);
    res.status(202).json({ ok: true, replayingFrom: fromLedger });
  } catch (err) {
    res.status(500).json({ error: 'Replay failed' });
  }
});

export default router;
