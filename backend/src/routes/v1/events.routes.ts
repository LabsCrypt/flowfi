import { Router } from 'express';
import type { Request, Response } from 'express';
import { subscribe } from '../../controllers/sse.controller.js';
import { sseService } from '../../services/sse.service.js';

const router = Router();

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
router.get('/subscribe', subscribe);

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
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
router.get('/stats', (req: Request, res: Response) => {
  res.json({
    activeConnections: sseService.getClientCount(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
