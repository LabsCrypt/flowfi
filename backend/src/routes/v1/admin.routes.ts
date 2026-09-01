import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAdmin } from '../../middleware/auth.js';
import { adminRateLimiter } from '../../middleware/admin-rate-limiter.middleware.js';
import {
  getIndexerStatus,
  resetIndexer,
  replayFromLedger,
} from '../../services/indexerService.js';

import { prisma, pool } from '../../lib/prisma.js';
import { getPoolMetrics } from '../../lib/pg-pool.js';
import { INDEXER_STATE_ID } from '../../lib/indexer-state.js';
import { sseService } from '../../services/sse.service.js';
import { cache } from '../../lib/redis.js';
import logger from '../../logger.js';
import { sorobanEventWorker } from '../../workers/soroban-event-worker.js';

const router = Router();

// All admin routes require admin JWT
router.use(requireAdmin);
router.use(adminRateLimiter);

/**
 * @openapi
 * /v1/admin/metrics:
 *   get:
 *     tags: [Admin]
 *     summary: Protocol health metrics
 *     security: [{ adminAuth: [] }]
 *     responses:
 *       200:
 *         description: Protocol health metrics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total_streams:
 *                   type: integer
 *                 active_streams:
 *                   type: integer
 *                 paused_streams:
 *                   type: integer
 *                 completed_streams:
 *                   type: integer
 *                 cancelled_streams:
 *                   type: integer
 *                 total_volume_streamed:
 *                   type: string
 *                   description: Sum of withdrawn amounts (i128 as string)
 *                 streams:
 *                   type: object
 *                   properties:
 *                     active: { type: integer }
 *                     paused: { type: integer }
 *                     total: { type: integer }
 *                     byStatus:
 *                       type: object
 *                       additionalProperties: { type: integer }
 *                 events:
 *                   type: object
 *                   properties:
 *                     last24h: { type: integer }
 *                 fees:
 *                   type: object
 *                   properties:
 *                     totalFeesCollectedByToken:
 *                       type: object
 *                       additionalProperties: { type: string }
 *                     feesLast24h:
 *                       type: object
 *                       additionalProperties: { type: string }
 *                 sse:
 *                   type: object
 *                   properties:
 *                     activeConnections: { type: integer }
 *                 indexer:
 *                   type: object
 *                   properties:
 *                     lastLedger: { type: integer }
 *                     lagSeconds: { type: integer, nullable: true }
 *                     lastUpdated: { type: string, format: date-time, nullable: true }
 *                     eventsProcessed: { type: integer }
 *                     eventsFailed: { type: integer }
 *                     lastErrorAt: { type: string, nullable: true }
 *                     degraded: { type: boolean }
 *                 cache:
 *                   type: object
 *                   additionalProperties: true
 *                 pgPool:
 *                   type: object
 *                   additionalProperties: true
 *                 uptime:
 *                   type: number
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 calculatedAt:
 *                   type: string
 *                   format: date-time
 *       401:
 *         description: Unauthorized - missing or invalid authentication token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Forbidden - admin access required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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
    prisma.indexerState.findUnique({ where: { id: INDEXER_STATE_ID } }),
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

  const eventCounters = sorobanEventWorker.getEventCounters();

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
    pgPool: getPoolMetrics(pool),
    indexer: {
      lastLedger: indexerState?.lastLedger ?? 0,
      lagSeconds,
      lastUpdated: indexerState?.updatedAt ?? null,
      eventsProcessed: eventCounters.eventsProcessed,
      eventsFailed: eventCounters.eventsFailed,
      lastErrorAt: eventCounters.lastErrorAt,
      degraded: eventCounters.degraded,
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };
}

/** Merge live in-memory indexer counters so a cache HIT still reflects spikes. */
function withLiveIndexerCounters<
  T extends { indexer: Record<string, unknown> },
>(payload: T): T {
  const counters = sorobanEventWorker.getEventCounters();
  return {
    ...payload,
    indexer: {
      ...payload.indexer,
      eventsProcessed: counters.eventsProcessed,
      eventsFailed: counters.eventsFailed,
      lastErrorAt: counters.lastErrorAt,
      degraded: counters.degraded,
    },
  };
}

/**
 * Attach a `calculatedAt` timestamp reflecting when the underlying aggregation
 * actually ran (i.e. when the metrics payload was stored in the cache), not
 * when this HTTP response is serialized. On a cache HIT this stays stable
 * across requests served from the same cache entry (Issue #1240).
 */
function withCalculatedAt<T extends object>(
  payload: T,
): T & { calculatedAt: string } {
  const createdAt = cache.getMetadata(ADMIN_METRICS_CACHE_KEY)?.createdAt;
  return {
    ...payload,
    calculatedAt: createdAt ?? new Date().toISOString(),
  };
}

router.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const cached = cache.get<Awaited<ReturnType<typeof buildAdminMetrics>>>(
      ADMIN_METRICS_CACHE_KEY,
    );
    if (cached) {
      res.set('X-Cache', 'HIT');
      res.json(withLiveIndexerCounters(withCalculatedAt(cached)));
      return;
    }

    const payload = await buildAdminMetrics();
    cache.set(ADMIN_METRICS_CACHE_KEY, payload, ADMIN_METRICS_CACHE_TTL_SECONDS);
    res.set('X-Cache', 'MISS');
    res.json(withCalculatedAt(payload));
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
 *     security: [{ adminAuth: [] }]
 *     responses:
 *       200:
 *         description: Indexer status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: true
 *       401:
 *         description: Unauthorized - missing or invalid authentication token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Forbidden - admin access required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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
 *     security: [{ adminAuth: [] }]
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
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *                 lastLedger: { type: integer }
 *       400:
 *         description: Invalid ledger value
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized - missing or invalid authentication token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Forbidden - admin access required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
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
 *     summary: Replay events from a given ledger (StreamEvent rows deduplicated; stream mutations not idempotent — see indexerService.ts JSDoc)
 *     security: [{ adminAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: from_ledger
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       202:
 *         description: Replay started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *                 replayingFrom: { type: integer }
 *                 requestId: { type: string }
 *       400:
 *         description: Invalid from_ledger value
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized - missing or invalid authentication token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Forbidden - admin access required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/indexer/replay', async (req: Request, res: Response) => {
  const fromLedger = Number(req.query.from_ledger);
  if (!Number.isInteger(fromLedger) || fromLedger < 0) {
    res.status(400).json({ error: 'from_ledger must be a non-negative integer' });
    return;
  }
  try {
    const requestId = await replayFromLedger(fromLedger);
    res.status(202).json({ ok: true, replayingFrom: fromLedger, requestId });
  } catch (err) {
    res.status(500).json({ error: 'Replay failed' });
  }
});

export default router;
