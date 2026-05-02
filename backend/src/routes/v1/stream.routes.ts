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
import { authMiddleware } from '../../middleware/auth.middleware.js';
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
router.post('/', authMiddleware, streamCreationRateLimiter, createStream);

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
router.post('/:streamId/pause', authMiddleware, pauseStream);

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
router.post('/:streamId/resume', authMiddleware, resumeStream);

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
router.post('/:streamId/withdraw', authMiddleware, withdrawHandler as any);

/**
 * @openapi
 * /v1/streams/{streamId}/cancel:
 *   post:
 *     tags:
 *       - Streams
 *     summary: Cancel an active payment stream
 *     security:
 *       - bearerAuth: []
 */
router.post('/:streamId/top-up', authMiddleware, topUpStreamHandler);
router.post('/:streamId/cancel', authMiddleware, cancelStreamHandler as any);

export default router;
