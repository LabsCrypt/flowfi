import { Router, type Request, type Response } from 'express';
import { prisma } from '../lib/prisma.js';

const router = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     tags:
 *       - Health
 *     summary: Detailed health check
 *     description: Returns detailed health information about the API, database, and indexer.
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
 *                 indexerLag:
 *                   type: integer
 *                   description: Seconds since last indexer update
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

  let indexerLag = -1;
  try {
    const state = await prisma.indexerState.findUnique({ where: { id: 'singleton' } });
    if (state) {
      const now = Math.floor(Date.now() / 1000);
      const updatedAt = Math.floor(state.updatedAt.getTime() / 1000);
      indexerLag = Math.max(0, now - updatedAt);
    }
  } catch {
    // If indexer state query fails, we treat it as degraded
    indexerLag = -1;
  }

  const isHealthy = dbStatus === 'connected' && (indexerLag >= 0 && indexerLag <= 60);
  const status = isHealthy ? 'ok' : 'degraded';

  res.status(isHealthy ? 200 : 503).json({
    status,
    db: dbStatus,
    indexerLag: indexerLag === -1 ? null : indexerLag,
    uptime: process.uptime(),
  });
});

export default router;
