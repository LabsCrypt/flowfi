import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { sseService } from '../services/sse.service.js';
import logger from '../logger.js';

const router = Router();

function adminAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'Admin access not configured on this instance.' });
    return;
  }
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

/**
 * @openapi
 * /v1/admin/metrics:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Protocol health metrics
 *     description: |
 *       Returns detailed protocol health metrics including stream counts, indexer state,
 *       SSE connection count, and server uptime. Requires admin Bearer token.
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: Protocol health metrics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 streams:
 *                   type: object
 *                   properties:
 *                     active:
 *                       type: integer
 *                     total:
 *                       type: integer
 *                     byStatus:
 *                       type: object
 *                       properties:
 *                         active:
 *                           type: integer
 *                         cancelled:
 *                           type: integer
 *                         completed:
 *                           type: integer
 *                 events:
 *                   type: object
 *                   properties:
 *                     last24h:
 *                       type: integer
 *                 sse:
 *                   type: object
 *                   properties:
 *                     activeConnections:
 *                       type: integer
 *                     perIpPeakConnections:
 *                       type: integer
 *                 indexer:
 *                   type: object
 *                   properties:
 *                     lastLedger:
 *                       type: integer
 *                     lagSeconds:
 *                       type: integer
 *                       nullable: true
 *                     lastUpdated:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 *                 uptime:
 *                   type: number
 *                   description: Server uptime in seconds
 *       401:
 *         description: Unauthorized — missing or invalid admin token
 *       503:
 *         description: Admin access not configured
 */
router.get('/metrics', adminAuth, async (_req: Request, res: Response) => {
  try {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [activeCount, totalCount, cancelledCount, completedCount, eventsLast24h, indexerState] =
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
      ]);

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
      sse: {
        activeConnections: sseService.getClientCount(),
        perIpPeakConnections: sseService.getPerIpPeakConnections(),
      },
      indexer: {
        lastLedger: indexerState?.lastLedger ?? 0,
        lagSeconds,
        lastUpdated: indexerState?.updatedAt ?? null,
      },
      uptime: process.uptime(),
    });
  } catch (err) {
    logger.error('Error fetching admin metrics:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
