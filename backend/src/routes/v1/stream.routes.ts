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
 *     description: Creates or reactivates a payment stream record for the authenticated wallet. The authenticated wallet must be the stream sender.
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [streamId, sender, recipient, tokenAddress, ratePerSecond, depositedAmount, startTime]
 *             properties:
 *               streamId:
 *                 type: integer
 *                 description: On-chain stream ID
 *                 example: 1
 *               sender:
 *                 type: string
 *                 description: Sender Stellar public key — must match the authenticated wallet
 *                 example: "GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA"
 *               recipient:
 *                 type: string
 *                 description: Recipient Stellar public key
 *                 example: "GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD"
 *               tokenAddress:
 *                 type: string
 *                 description: Token contract address
 *                 example: "CBCD789EFG012HIJ345KLM678NOP901QRS234TUV567WXY890ZAB123CDE"
 *               ratePerSecond:
 *                 type: string
 *                 description: Payment rate per second (i128 as string)
 *                 example: "100"
 *               depositedAmount:
 *                 type: string
 *                 description: Total deposited amount (i128 as string)
 *                 example: "10000"
 *               startTime:
 *                 type: integer
 *                 description: Stream start time (Unix timestamp)
 *                 example: 1708531200
 *     responses:
 *       201:
 *         description: Stream created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Stream'
 *       400:
 *         description: Invalid input data
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
 *         description: Forbidden - sender does not match the authenticated wallet, or stream is owned by another wallet
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Too Many Requests - rate limit exceeded (10 requests per minute)
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
router.post('/', requireAuth, streamCreationRateLimiter, createStream);

/**
 * @openapi
 * /v1/streams:
 *   get:
 *     tags:
 *       - Streams
 *     summary: List payment streams
 *     description: Retrieve a list of payment streams with optional filtering, sorting, and pagination.
 *     parameters:
 *       - in: query
 *         name: sender
 *         schema: { type: string }
 *         description: Filter by sender public key
 *       - in: query
 *         name: recipient
 *         schema: { type: string }
 *         description: Filter by recipient public key
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, cancelled, completed, paused]
 *         description: Filter by stream status
 *       - in: query
 *         name: token
 *         schema: { type: string }
 *         description: Filter by token contract address
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [createdAt, startTime, lastUpdateTime, depositedAmount, endTime]
 *           default: createdAt
 *         description: Sort field
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           minimum: 1
 *           maximum: 100
 *         description: Max results per page (capped at 100)
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *           minimum: 0
 *         description: Number of results to skip
 *     responses:
 *       200:
 *         description: Paginated list of streams
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StreamListResponse'
 *       400:
 *         description: Invalid status or pagination parameters
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
router.get('/', listStreams);

/**
 * @openapi
 * /v1/streams/summary/{address}:
 *   get:
 *     tags:
 *       - Streams
 *     summary: Get user stream summary
 *     description: Aggregate dashboard/profile summary for a wallet address. Cached for 30 seconds.
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Stellar public key
 *     responses:
 *       200:
 *         description: User stream summary
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UserStreamSummary'
 *       400:
 *         description: Address is required
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
router.get('/summary/:address', getUserStreamSummary);

/**
 * @openapi
 * /v1/streams/{streamId}:
 *   get:
 *     tags:
 *       - Streams
 *     summary: Get stream details
 *     description: Returns a single stream. Falls back to live on-chain data when the DB record is missing or stale.
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
 *       400:
 *         description: Invalid streamId parameter
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Stream not found
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
 *           maximum: 200
 *         description: "Number of events to return per page (default: 50, max: 200)"
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
 *           enum: [CREATED, TOPPED_UP, WITHDRAWN, CANCELLED, COMPLETED, PAUSED, RESUMED, FEE_COLLECTED, FEE_CONFIG_UPDATED, ADMIN_TRANSFERRED]
 *         description: Filter events by type
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *           minimum: 1
 *         description: 1-based page index (offset based). Ignored when `cursor` is set.
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Event id cursor for stable pagination (hasMore-aware). Ignored when `offset` is set.
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: "Sort order by timestamp (default: desc)"
 *     responses:
 *       200:
 *         description: Paginated stream events
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StreamEventListResponse'
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Stream not found
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
router.get('/:streamId/events', getStreamEvents);

/**
 * @openapi
 * /v1/streams/{streamId}/claimable:
 *   get:
 *     tags:
 *       - Streams
 *     summary: Get actionable claimable amount for a stream
 *     description: Returns the amount claimable right now (or at an optional timestamp). Uses a 5s-cached computation, with an on-chain fallback when the record is missing or stale.
 *     parameters:
 *       - in: path
 *         name: streamId
 *         required: true
 *         schema:
 *           type: integer
 *         description: On-chain stream ID
 *       - in: query
 *         name: at
 *         schema:
 *           type: integer
 *           minimum: 0
 *         description: Optional Unix timestamp (seconds) to compute the claimable amount at
 *     responses:
 *       200:
 *         description: Claimable amount
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ClaimableResponse'
 *       400:
 *         description: Invalid streamId or `at` parameter
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Stream not found
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
 *               $ref: '#/components/schemas/PauseResumeResponse'
 *       400:
 *         description: Invalid streamId, or on-chain pause simulation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized - missing or invalid authentication
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Forbidden - caller is not the stream sender
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Stream not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Conflict - stream already paused or inactive
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
 *               $ref: '#/components/schemas/PauseResumeResponse'
 *       400:
 *         description: Invalid streamId, or on-chain resume simulation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized - missing or invalid authentication
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Forbidden - caller is not the stream sender
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Stream not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Conflict - stream not paused or inactive
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
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/WithdrawResponse'
 *       400:
 *         description: Invalid streamId or contract revert
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized - missing or invalid authentication
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Forbidden - caller is not the stream recipient
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Stream not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Conflict - no claimable balance available
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
 *               $ref: '#/components/schemas/TopUpResponse'
 *       400:
 *         description: Invalid request — amount missing or not a positive integer string
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
 *         description: Forbidden - caller is not the stream sender
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Stream not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Conflict - stream inactive or paused
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
router.post('/:streamId/top-up', requireAuth, topUpStreamHandler);

/**
 * @openapi
 * /v1/streams/{streamId}/cancel:
 *   post:
 *     tags:
 *       - Streams
 *     summary: Cancel an active payment stream
 *     description: Cancels an active payment stream. Only the sender can cancel; accrued tokens go to the recipient and the remainder is refunded to the sender.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: streamId
 *         required: true
 *         schema:
 *           type: integer
 *         description: On-chain stream ID
 *     responses:
 *       200:
 *         description: Stream cancelled successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CancelResponse'
 *       400:
 *         description: Invalid streamId or transaction simulation failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized - missing or invalid authentication
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Forbidden - only the sender can cancel
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Stream not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Stream already cancelled or completed
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
router.post('/:streamId/cancel', requireAuth, cancelStreamHandler as any);

export default router;
