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
router.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [activeCount, totalCount, cancelledCount, completedCount, eventsLast24h, indexerState, feeEvents, feesLast24h] =
      await Promise.all([
        prisma.stream.count({ where: { isActive: true } }),
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

    const nowSec = Math.floor(Date.now() / 1000);
    const lagSeconds = indexerState
      ? nowSec - Math.floor(indexerState.updatedAt.getTime() / 1000)
      : null;

    res.json({
      streams: {
        active: activeCount,
        total: totalCount,
        byStatus: {
          active: activeCount,
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
      cache: cache.getStats(), // Added my cache metrics
      indexer: {
        lastLedger: indexerState?.lastLedger ?? 0,
        lagSeconds,
        lastUpdated: indexerState?.updatedAt ?? null,
      },
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
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
