import { Router } from 'express';
import {
  createStream,
  listStreams,
  getStream,
  getStreamEvents,
  getStreamClaimableAmount,
  getUserStreamSummary,
  topUpStreamHandler,
  pauseStream,
  resumeStream,
} from '../../controllers/stream.controller.js';
import { cancelStreamHandler } from '../../controllers/stream/cancel.js';
import { withdrawHandler } from './streams/withdraw.js';
import { requireAuth } from '../../middleware/auth.js';
import { streamCreationRateLimiter } from '../../middleware/stream-rate-limiter.middleware.js';

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
router.post('/', requireAuth, streamCreationRateLimiter, createStream);

/**
 * @openapi
 * /v1/streams:
 *   get:
 *     tags:
 *       - Streams
 *     summary: List payment streams
 *     description: Retrieve a list of payment streams with optional filtering.
 */
router.get('/', listStreams);

/**
 * @openapi
 * /v1/streams/summary/{address}:
 *   get:
 *     tags:
 *       - Streams
 *     summary: Get user stream summary
 */
router.get('/summary/:address', getUserStreamSummary);

/**
 * @openapi
 * /v1/streams/{streamId}:
 *   get:
 *     tags:
 *       - Streams
 *     summary: Get stream details
 */
router.get('/:streamId', getStream);

/**
 * @openapi
 * /v1/streams/{streamId}/events:
 *   get:
 *     tags:
 *       - Streams
 *     summary: Get stream events
 *     description: Retrieve events for a specific stream with pagination, filtering, and sorting.
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
 *           minimum: 1
 *           maximum: 500
 *         description: "Number of events to return per page (default: 50, max: 500)"
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *           minimum: 0
 *         description: "Number of events to skip (default: 0)"
 *       - in: query
 *         name: eventType
 *         schema:
 *           type: string
 *           enum: [CREATED, TOPPED_UP, WITHDRAWN, CANCELLED, COMPLETED, PAUSED, RESUMED, FEE_COLLECTED]
 *         description: Filter events by type
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: "Sort order by timestamp (default: desc)"
 *     responses:
 *       200:
 *         description: Stream events retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       streamId:
 *                         type: integer
 *                       eventType:
 *                         type: string
 *                       transactionHash:
 *                         type: string
 *                       ledgerSequence:
 *                         type: integer
 *                       timestamp:
 *                         type: integer
 *                       metadata:
 *                         type: string
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                 total:
 *                   type: integer
 *                   description: Total number of events matching the filter
 *                 hasMore:
 *                   type: boolean
 *                   description: Whether there are more events available
 *       400:
 *         description: Invalid request parameters
 *       404:
 *         description: Stream not found
 *       500:
 *         description: Internal server error
 */
router.get('/:streamId/events', getStreamEvents);

/**
 * @openapi
 * /v1/streams/{streamId}/claimable:
 *   get:
 *     tags:
 *       - Streams
 *     summary: Get actionable claimable amount for a stream
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
router.post('/:streamId/withdraw', requireAuth, withdrawHandler as any);

/**
 * @openapi
 * /v1/streams/{streamId}/top-up:
 *   post:
 *     tags:
 *       - Streams
 *     summary: Top up a payment stream
 *     description: Adds additional funds to an existing active stream. Only the original sender can top up.
 *     parameters:
 *       - in: path
 *         name: streamId
 *         required: true
 *         schema:
 *           type: integer
 *         description: On-chain stream ID
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - amount
 *             properties:
 *               amount:
 *                 type: string
 *                 description: Amount to add to the stream deposit (i128 as string)
 *                 example: '5000'
 *     responses:
 *       200:
 *         description: Stream topped up successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 txHash:
 *                   type: string
 *                 streamId:
 *                   type: integer
 *                 newDepositedAmount:
 *                   type: string
 *       400:
 *         description: Invalid request — amount missing or not a positive integer string
 *       401:
 *         description: Unauthorized - missing or invalid authentication token
 *       403:
 *         description: Forbidden - caller is not the stream sender
 *       404:
 *         description: Stream not found
 */
router.post('/:streamId/top-up', requireAuth, topUpStreamHandler);
router.post('/:streamId/cancel', requireAuth, cancelStreamHandler as any);

export default router;
