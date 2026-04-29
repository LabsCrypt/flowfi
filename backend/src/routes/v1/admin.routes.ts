import { Router } from 'express';
import type { Request, Response } from 'express';
import { cache } from '../../lib/redis.js';

const router = Router();

/**
 * @openapi
 * /v1/admin/metrics:
 *   get:
 *     tags:
 *       - Admin
 *     summary: Get system metrics
 *     description: Returns performance metrics including cache hit rates.
 *     responses:
 *       200:
 *         description: System metrics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 cache:
 *                   type: object
 *                   properties:
 *                     hits:
 *                       type: number
 *                     misses:
 *                       type: number
 *                     hitRate:
 *                       type: number
 *                     itemCount:
 *                       type: number
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
router.get('/metrics', (req: Request, res: Response) => {
  res.json({
    cache: cache.getStats(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
