import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { subscribe } from '../../controllers/sse.controller.js';
import { sseService } from '../../services/sse.service.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import type { AuthenticatedRequest } from '../../types/auth.types.js';
import logger from '../../logger.js';
import {
  listEventsForWallet,
  parseEventTypeFilter,
  resolveEventsOffset,
  resolveEventsPageSize,
} from '../../repositories/streamEvent.repository.js';

const router = Router();

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
 *           RESUMED, FEE_COLLECTED, FEE_CONFIG_UPDATED, ADMIN_TRANSFERRED.
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
 *       - in: query
 *         name: includeStream
 *         required: false
 *         schema: { type: boolean, default: false }
 *         description: When true, each event includes its related `stream`.
 *     responses:
 *       200:
 *         description: Paginated event list
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/EventListResponse'
 *       400:
 *         description: Missing/invalid `address` or invalid `type` filter
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
 *         description: Forbidden - `address` must match the authenticated wallet
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
router.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { publicKey } = (req as AuthenticatedRequest).user;
    const address = typeof req.query.address === 'string' ? req.query.address.trim() : '';
    if (!address) {
      res.status(400).json({ error: 'address query parameter is required' });
      return;
    }

    // Aligned with SSE security: history queries require authentication and are scoped to the caller.
    if (address !== publicKey) {
      res.status(403).json({ error: 'Forbidden', message: 'You can only view your own event history' });
      return;
    }

    const { requested, types } = parseEventTypeFilter(req.query.type);
    if (requested.length > 0 && types.length === 0) {
      res.status(400).json({ error: 'No valid event types in `type` filter' });
      return;
    }

    const limit = resolveEventsPageSize(req.query.limit);
    const offset = resolveEventsOffset({
      rawOffset: req.query.offset,
      rawPage: req.query.page,
      limit,
    });
    const includeStream = req.query.includeStream === 'true';

    const result = await listEventsForWallet({
      address,
      types,
      limit,
      offset,
      includeStream,
    });

    res.json({
      events: result.events,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      hasMore: result.hasMore,
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
 *         description: SSE connection established. Events are emitted as `data:` frames of type stream.created, stream.topped_up, stream.withdrawn, stream.cancelled, stream.completed, stream.paused, stream.resumed, fee.collected.
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *               description: Server-Sent Events stream; each event carries a JSON payload matching the StreamEvent schema
 *       400:
 *         description: Invalid subscription parameters
 *       401:
 *         description: Unauthorized - missing or invalid authentication token
 */
router.get('/subscribe', requireAuth, subscribe);

/**
 * @openapi
 * /v1/events/stats:
 *   get:
 *     tags:
 *       - Events
 *     summary: Get SSE connection statistics
 *     description: Returns current SSE connection metrics for monitoring (admin only)
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: Connection statistics
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SseStats'
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
router.get('/stats', requireAdmin, (req: Request, res: Response) => {
  res.json({
    activeConnections: sseService.getClientCount(),
    activeIps: sseService.getActiveIpCount(),
    perIpPeakConnections: sseService.getPerIpPeakConnections(),
    maxConnections: sseService.getMaxConnections(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
