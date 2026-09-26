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
import { simulateStreamHandler } from '../../controllers/stream/simulate.js';
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
 * /v1/streams/simulate:
 *   post:
 *     tags:
 *       - Streams
 *     summary: Simulate a stream contract call (client-side signing)
 *     description: |
 *       Runs a Soroban `simulateTransaction` for the requested action and
 *       returns an **unsigned** transaction with the ledger footprint, resource
 *       limits and a padded resource fee already applied, ready for a browser
 *       wallet (Freighter, Lobstr, xBull) to sign.
 *
 *       The returned XDR carries the sender's sequence number as of the moment
 *       of simulation, so clients should sign promptly rather than holding the
 *       response open. A 15% resource-fee buffer is applied on top of the
 *       simulated minimum to absorb footprint drift between simulation and
 *       submission.
 *
 *       Reverted simulations return HTTP 400 with the decoded contract error
 *       code and a remediation hint in `details`.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - action
 *               - senderPublicKey
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [create, withdraw, cancel, top_up, batch_withdraw]
 *                 example: create
 *               senderPublicKey:
 *                 type: string
 *                 description: Stellar account that will sign the transaction
 *                 example: GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF
 *               params:
 *                 type: object
 *                 description: |
 *                   Action-specific arguments. `create` needs `recipient`,
 *                   `amount`, `duration` and `tokenAddress`; `withdraw` and
 *                   `cancel` need `streamId`; `top_up` needs `streamId` and
 *                   `amount`; `batch_withdraw` needs `streamIds`.
 *                 properties:
 *                   streamId:
 *                     type: string
 *                     example: '123'
 *                   streamIds:
 *                     type: array
 *                     items:
 *                       type: string
 *                   recipient:
 *                     type: string
 *                     example: GBBJ6H3FJN34VLIGNU2QZJ4T6NMY4B2LKCVYGCXK5HO3JFXKHTGSHRQ
 *                   amount:
 *                     type: string
 *                     description: Amount in the token's smallest unit (i128 as string)
 *                     example: '1000000000'
 *                   duration:
 *                     type: integer
 *                     description: Stream duration in seconds
 *                     example: 2592000
 *                   tokenAddress:
 *                     type: string
 *                     description: Token contract address — required for `create`
 *     responses:
 *       200:
 *         description: Simulation succeeded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     unsignedXdr:
 *                       type: string
 *                       description: Base64-encoded unsigned transaction XDR
 *                       example: AAAAAB...
 *                     minResourceFee:
 *                       type: string
 *                       description: Simulated minimum resource fee in stroops
 *                       example: '15000'
 *                     recommendedFee:
 *                       type: string
 *                       description: minResourceFee plus a 15% safety buffer
 *                       example: '17250'
 *                     cpuInstructions:
 *                       type: integer
 *                       example: 1420500
 *                     memoryBytes:
 *                       type: integer
 *                       example: 524000
 *                     expiresAtLedger:
 *                       type: integer
 *                       description: Last ledger the returned footprint is valid against
 *                       example: 482910
 *                     simulatedReturn:
 *                       type: string
 *                       description: Decoded contract return value (empty string for void returns)
 *                       example: '100000000'
 *       400:
 *         description: Invalid parameters, or the simulation reverted
 *       503:
 *         description: Stream contract is not configured
 */
router.post('/simulate', simulateStreamHandler);

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
