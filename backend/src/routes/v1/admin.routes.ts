import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireAdmin } from '../../middleware/auth.js';
import {
  getIndexerStatus,
  resetIndexer,
  replayFromLedger,
} from '../../services/indexerService.js';
import {
  discardDeadLetterHandler,
  listDeadLetterHandler,
  replayAllDeadLetterHandler,
  replayDeadLetterHandler,
} from '../../controllers/admin.controller.js';

import { prisma } from '../../lib/prisma.js';
import { INDEXER_STATE_ID } from '../../lib/indexer-state.js';
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
 *     security: [{ adminAuth: [] }]
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
 *     security: [{ adminAuth: [] }]
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

// ─── Dead-letter quarantine ───────────────────────────────────────────────────
//
// Events the indexer could not process are quarantined instead of retried
// inline, so one malformed payload cannot stall the worker cursor. These routes
// are the operator interface to that table: inspect, replay, or discard.
//
// `requireAdmin` is applied router-wide above, so every route here requires an
// admin JWT and answers 401/403 to unauthenticated callers.

/**
 * @openapi
 * /v1/admin/indexer/dead-letter:
 *   get:
 *     tags: [Admin]
 *     summary: List quarantined indexer events
 *     description: |
 *       Paginated, filterable view of Soroban events the indexer failed to
 *       process. Each entry carries the raw payload and the most recent error,
 *       with `attempts` recording how many times processing has been tried.
 *     security: [{ adminAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 25 }
 *       - in: query
 *         name: ledgerSequence
 *         schema: { type: integer }
 *         description: Return only events from this ledger
 *       - in: query
 *         name: startDate
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: endDate
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: eventType
 *         schema: { type: string, example: stream_created }
 *     responses:
 *       200:
 *         description: Paginated dead-letter records
 *       400:
 *         description: Invalid query parameters
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - admin access required
 */
router.get('/indexer/dead-letter', listDeadLetterHandler);

/**
 * @openapi
 * /v1/admin/indexer/dead-letter/replay-all:
 *   post:
 *     tags: [Admin]
 *     summary: Replay every pending dead-letter event
 *     description: |
 *       Replays all pending records sequentially, oldest ledger first, so events
 *       for the same stream apply in their original order.
 *     security: [{ adminAuth: [] }]
 *     responses:
 *       200:
 *         description: Per-record replay outcomes plus an aggregate summary
 */
router.post('/indexer/dead-letter/replay-all', replayAllDeadLetterHandler);

/**
 * @openapi
 * /v1/admin/indexer/dead-letter/{id}/replay:
 *   post:
 *     tags: [Admin]
 *     summary: Replay a single quarantined event
 *     description: |
 *       Re-injects the payload through the indexer pipeline. On success the
 *       dead-letter row is deleted and the corresponding Stream / StreamEvent
 *       records are created; on failure `attempts` is incremented and
 *       `lastAttemptAt` / `errorMessage` are refreshed.
 *     security: [{ adminAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Event replayed and removed from the dead-letter table
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - admin access required
 *       404:
 *         description: Dead-letter event not found
 *       422:
 *         description: Replay ran but failed, or the payload is undecodable
 */
router.post('/indexer/dead-letter/:id/replay', replayDeadLetterHandler);

/**
 * @openapi
 * /v1/admin/indexer/dead-letter/{id}:
 *   delete:
 *     tags: [Admin]
 *     summary: Permanently discard a quarantined event
 *     description: |
 *       Deletes an unrecoverable record. The discard is written to the
 *       application log with the acting admin key so the loss of an on-chain
 *       event remains auditable.
 *     security: [{ adminAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Record discarded
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - admin access required
 *       404:
 *         description: Dead-letter event not found
 */
router.delete('/indexer/dead-letter/:id', discardDeadLetterHandler);

export default router;