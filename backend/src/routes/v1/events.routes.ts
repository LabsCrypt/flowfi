import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { subscribe } from '../../controllers/sse.controller.js';
import { sseService } from '../../services/sse.service.js';
import { requireAuth } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';
import logger from '../../logger.js';

const router = Router();

const EVENT_TYPES = new Set([
  'CREATED',
  'TOPPED_UP',
  'WITHDRAWN',
  'CANCELLED',
  'COMPLETED',
  'PAUSED',
  'RESUMED',
  'FEE_COLLECTED',
]);

const MAX_EVENT_LIMIT = 200;
const DEFAULT_EVENT_LIMIT = 50;

/**
 * @openapi
 * /v1/events:
 *   get:
 *     tags: [Events]
 *     summary: List stream events for a wallet (paginated, filterable)
 *     description: |
 *       Returns a reverse-chronological list of stream events where the wallet
 *       was either the sender or recipient. Supports event-type filtering and
 *       limit/offset pagination — used by the frontend activity timeline.
 *     parameters:
 *       - in: query
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Stellar public key (G...)
 *       - in: query
 *         name: type
 *         required: false
 *         schema: { type: string }
 *         description: |
 *           Comma-separated list of event types to include. Allowed values:
 *           CREATED, TOPPED_UP, WITHDRAWN, CANCELLED, COMPLETED, PAUSED,
 *           RESUMED, FEE_COLLECTED.
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, default: 50, maximum: 200 }
 *       - in: query
 *         name: offset
 *         required: false
 *         schema: { type: integer, default: 0 }
 *       - in: query
 *         name: page
 *         required: false
 *         schema: { type: integer, default: 1 }
 *         description: Optional 1-based page index. Ignored when offset is set.
 *     responses:
 *       200:
 *         description: Paginated event list
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const address = typeof req.query.address === 'string' ? req.query.address.trim() : '';
    if (!address) {
      res.status(400).json({ error: 'address query parameter is required' });
      return;
    }

    const rawType = typeof req.query.type === 'string' ? req.query.type : '';
    const requested = rawType
      .split(',')
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
    const types = requested.filter((t) => EVENT_TYPES.has(t));
    if (requested.length > 0 && types.length === 0) {
      res.status(400).json({ error: 'No valid event types in `type` filter' });
      return;
    }

    const parsedLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_EVENT_LIMIT)
      : DEFAULT_EVENT_LIMIT;

    const hasOffset = req.query.offset !== undefined;
    const parsedOffset = Number.parseInt(String(req.query.offset ?? ''), 10);
    const parsedPage = Number.parseInt(String(req.query.page ?? ''), 10);
    const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    const offset = hasOffset && Number.isFinite(parsedOffset) && parsedOffset >= 0
      ? parsedOffset
      : (page - 1) * limit;

    const where: {
      stream: { OR: Array<{ sender: string } | { recipient: string }> };
      eventType?: { in: string[] };
    } = {
      stream: {
        OR: [{ sender: address }, { recipient: address }],
      },
    };
    if (types.length > 0) {
      where.eventType = { in: types };
    }

    const [events, total] = await Promise.all([
      prisma.streamEvent.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        skip: offset,
        take: limit,
      }),
      prisma.streamEvent.count({ where }),
    ]);

    res.json({
      events,
      total,
      limit,
      offset,
      hasMore: offset + events.length < total,
    });
  } catch (err) {
    logger.error('GET /v1/events failed:', err);
    next(err);
  }
});

/**
 * @openapi
 * /v1/events/subscribe:
 *   get:
 *     tags:
 *       - Events
 *     summary: Subscribe to real-time stream events
 *     description: |
 *       Establishes a Server-Sent Events (SSE) connection for real-time updates.
 *       
 *       **Reconnection Strategy:**
 *       - Browser automatically reconnects with exponential backoff
 *       - Initial retry: 1s, max: 30s
 *       - Client should implement custom reconnection logic for production
 *       
 *       **Event Types:**
 *       - `stream.created` - New stream created
 *       - `stream.topped_up` - Stream received additional funds
 *       - `stream.withdrawn` - Funds withdrawn from stream
 *       - `stream.cancelled` - Stream cancelled
 *       - `stream.completed` - Stream completed
 *       
 *       **Sandbox Mode:**
 *       - Add header `X-Sandbox-Mode: true` or query parameter `?sandbox=true`
 *       - Sandbox events are clearly marked with `_sandbox` metadata
 *       - Sandbox events are isolated from production events
 *     parameters:
 *       - in: header
 *         name: X-Sandbox-Mode
 *         schema:
 *           type: string
 *           enum: ["true", "1"]
 *         description: Enable sandbox mode for testing
 *         required: false
 *       - in: query
 *         name: sandbox
 *         schema:
 *           type: string
 *           enum: ["true", "1"]
 *         description: Enable sandbox mode via query parameter
 *         required: false
 *       - in: query
 *         name: streams
 *         schema:
 *           type: array
 *           items:
 *             type: string
 *         description: Array of stream IDs to subscribe to
 *         example: ["1", "2"]
 *       - in: query
 *         name: users
 *         schema:
 *           type: array
 *           items:
 *             type: string
 *         description: Array of user public keys to subscribe to
 *         example: ["GABC...", "GDEF..."]
 *       - in: query
 *         name: all
 *         schema:
 *           type: boolean
 *         description: Subscribe to all events
 *         example: false
 *     responses:
 *       200:
 *         description: SSE connection established
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       400:
 *         description: Invalid subscription parameters
 */
router.get('/subscribe', requireAuth, subscribe);

/**
 * @openapi
 * /v1/events/stats:
 *   get:
 *     tags:
 *       - Events
 *     summary: Get SSE connection statistics
 *     description: Returns current SSE connection metrics for monitoring
 *     responses:
 *       200:
 *         description: Connection statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 activeConnections:
 *                   type: number
 *                   example: 42
 *                 activeIps:
 *                   type: number
 *                   example: 8
 *                 perIpPeakConnections:
 *                   type: number
 *                   example: 5
 *                 maxConnections:
 *                   type: number
 *                   example: 10000
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
router.get('/stats', (req: Request, res: Response) => {
  res.json({
    activeConnections: sseService.getClientCount(),
    activeIps: sseService.getActiveIpCount(),
    perIpPeakConnections: sseService.getPerIpPeakConnections(),
    maxConnections: sseService.getMaxConnections(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
