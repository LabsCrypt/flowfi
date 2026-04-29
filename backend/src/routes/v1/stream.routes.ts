import { Router } from 'express';
import { 
  createStream, 
  listStreams, 
  getStream, 
  getStreamEvents, 
  getStreamClaimableAmount,
  getUserStreamSummary,
  pauseStream,
  resumeStream,
  withdrawStream,
} from '../../controllers/stream.controller.js';
import { requireAuth } from '../../middleware/auth.js';

const router = Router();

/**
 * @openapi
 * /v1/streams:
 *   post:
 *     tags:
 *       - Streams
 *     summary: Create a new payment stream
 *     description: Creates a new payment stream on the Stellar network.
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       201:
 *         description: Stream created successfully
 *       400:
 *         description: Invalid input data
 *       401:
 *         description: Unauthorized - missing or invalid authentication token
 *       429:
 *         description: Too Many Requests - rate limit exceeded (10 requests per minute)
 */
router.post('/', authMiddleware, streamCreationRateLimiter, createStream);

/**
 * @openapi
 * /v1/streams:
 *   get:
 *     tags:
 *       - Streams
 *     summary: List payment streams
 *     description: Retrieve a list of payment streams with optional filtering.
 *     parameters:
 *       - in: query
 *         name: sender
 *         schema:
 *           type: string
 *         description: Filter by sender public key
 *       - in: query
 *         name: recipient
 *         schema:
 *           type: string
 *         description: Filter by recipient public key
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, cancelled, completed, paused]
 *         description: Filter by stream status
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Maximum number of streams to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of streams to skip
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [createdAt, startTime, lastUpdateTime, depositedAmount, endTime]
 *           default: createdAt
 *         description: Field to sort by
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order
 *     responses:
 *       200:
 *         description: A list of payment streams
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Stream'
 *                 total:
 *                   type: integer
 *                 hasMore:
 *                   type: boolean
 */
router.get('/', listStreams);

/**
 * @openapi
 * /v1/streams/summary/{address}:
 *   get:
 *     tags:
 *       - Streams
 *     summary: Get user stream summary
 *     description: Returns aggregated stream data for a user (total created, streamed in/out, current claimable).
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         description: Stellar public key
 *     responses:
 *       200:
 *         description: User stream summary
 */
router.get('/summary/:address', getUserStreamSummary);

/**
 * @openapi
 * /v1/streams/{streamId}:
 *   get:
 *     tags:
 *       - Streams
 *     summary: Get stream details
 *     description: Retrieve detailed information about a specific stream.
 *     parameters:
 *       - in: path
 *         name: streamId
 *         required: true
 *         schema:
 *           type: integer
 *         description: On-chain stream ID
 *     responses:
 *       200:
 *         description: Stream details
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Stream'
 *       404:
 *         description: Stream not found
 */
router.get('/:streamId', getStream);

/**
 * @openapi
 * /v1/streams/{streamId}/events:
 *   get:
 *     tags:
 *       - Streams
 *     summary: Get stream events
 *     description: |
 *       Retrieve events for a specific stream with offset- or cursor-based pagination.
 *
 *       **Offset pagination:** Use `limit` and `offset`.
 *       **Cursor pagination:** Use `cursor=<eventId>` and `direction`. The cursor record
 *       itself is excluded; events immediately after (asc) or before (desc) it are returned.
 *     parameters:
 *       - in: path
 *         name: streamId
 *         required: true
 *         schema:
 *           type: integer
 *         description: On-chain stream ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 500
 *         description: Maximum number of events to return (default 50, max 500)
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of events to skip (offset pagination)
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Event ID to use as pagination cursor (cursor-based pagination)
 *       - in: query
 *         name: direction
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort direction (default desc)
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order by timestamp (default desc)
 *       - in: query
 *         name: eventType
 *         schema:
 *           type: string
 *           enum: [CREATED, TOPPED_UP, WITHDRAWN, CANCELLED, COMPLETED, PAUSED, RESUMED]
 *         description: Filter by event type
 *     responses:
 *       200:
 *         description: Paginated list of stream events
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/StreamEvent'
 *                 total:
 *                   type: integer
 *                   description: Total number of events for this stream
 *                   example: 120
 *                 hasMore:
 *                   type: boolean
 *                   description: Whether more events exist beyond the current page
 *                   example: true
 *       400:
 *         description: Invalid streamId
 *       404:
 *         description: Stream not found
 */
router.get('/:streamId/events', getStreamEvents);

/**
 * @openapi
 * /v1/streams/{streamId}/claimable:
 *   get:
 *     tags:
 *       - Streams
 *     summary: Get actionable claimable amount for a stream
 *     description: |
 *       Returns the exact actionable amount currently withdrawable from a stream,
 *       using indexed stream state in PostgreSQL and overflow-safe logic equivalent
 *       to the Soroban contract's `calculate_claimable` function.
 *
 *       **Performance:**
 *       - Uses an in-memory cache for hot reads
 *       - Does not call Soroban RPC for this computation
 *     parameters:
 *       - in: path
 *         name: streamId
 *         required: true
 *         schema:
 *           type: integer
 *         description: On-chain stream ID
 *       - in: query
 *         name: at
 *         required: false
 *         schema:
 *           type: integer
 *         description: Optional Unix timestamp in seconds used for deterministic calculation
 *     responses:
 *       200:
 *         description: Claimable amount calculated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 streamId:
 *                   type: integer
 *                   example: 1
 *                 claimableAmount:
 *                   type: string
 *                   description: Actionable amount currently withdrawable (i128 as string)
 *                   example: "1500"
 *                 actionable:
 *                   type: boolean
 *                   description: Whether a withdrawal is currently actionable
 *                   example: true
 *                 calculatedAt:
 *                   type: integer
 *                   description: Unix timestamp (seconds) used for calculation
 *                   example: 1708534800
 *                 cached:
 *                   type: boolean
 *                   description: Whether response was served from cache
 *                   example: false
 *       400:
 *         description: Invalid streamId or query parameter
 *       404:
 *         description: Stream not found
 */
router.get('/:streamId/claimable', getStreamClaimableAmount);

/**
 * @openapi
 * /v1/streams/{streamId}/pause:
 *   post:
 *     tags:
 *       - Streams
 *     summary: Pause a payment stream
 *     description: Pause an active stream. Only the sender can pause their own stream.
 *     parameters:
 *       - in: path
 *         name: streamId
 *         required: true
 *         schema:
 *           type: integer
 *         description: On-chain stream ID
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Stream paused successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 streamId:
 *                   type: integer
 *                 txHash:
 *                   type: string
 *                 stream:
 *                   $ref: '#/components/schemas/Stream'
 *       400:
 *         description: Invalid streamId or operation failed
 *       401:
 *         description: Unauthorized - missing or invalid authentication
 *       403:
 *         description: Forbidden - caller is not the stream sender
 *       404:
 *         description: Stream not found
 *       409:
 *         description: Conflict - stream already paused or inactive
 */
router.post('/:streamId/pause', requireAuth, pauseStream);

/**
 * @openapi
 * /v1/streams/{streamId}/resume:
 *   post:
 *     tags:
 *       - Streams
 *     summary: Resume a paused payment stream
 *     description: Resume a paused stream. Only the sender can resume their own stream.
 *     parameters:
 *       - in: path
 *         name: streamId
 *         required: true
 *         schema:
 *           type: integer
 *         description: On-chain stream ID
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Stream resumed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 streamId:
 *                   type: integer
 *                 txHash:
 *                   type: string
 *                 stream:
 *                   $ref: '#/components/schemas/Stream'
 *       400:
 *         description: Invalid streamId or operation failed
 *       401:
 *         description: Unauthorized - missing or invalid authentication
 *       403:
 *         description: Forbidden - caller is not the stream sender
 *       404:
 *         description: Stream not found
 *       409:
 *         description: Conflict - stream not paused or inactive
 */
router.post('/:streamId/resume', requireAuth, resumeStream);

/**
 * @openapi
 * /v1/streams/{streamId}/withdraw:
 *   post:
 *     tags:
 *       - Streams
 *     summary: Withdraw claimable balance from a payment stream
 *     description: Withdraws the currently claimable amount. Only the recipient can withdraw.
 *     parameters:
 *       - in: path
 *         name: streamId
 *         required: true
 *         schema:
 *           type: integer
 *         description: On-chain stream ID
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Withdrawal submitted successfully
 *       401:
 *         description: Unauthorized - missing or invalid authentication
 *       403:
 *         description: Forbidden - caller is not the stream recipient
 *       404:
 *         description: Stream not found
 *       409:
 *         description: Conflict - no claimable balance available
 */
router.post('/:streamId/withdraw', requireAuth, withdrawStream);

export default router;
