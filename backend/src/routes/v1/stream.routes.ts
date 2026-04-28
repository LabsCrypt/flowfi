import { Router } from 'express';
import {
  createStream,
  listStreams,
  getStream,
  getStreamEvents,
  getStreamClaimableAmount,
} from '../../controllers/stream.controller.js';

const router = Router();

/**
 * @openapi
 * /v1/streams:
 *   post:
 *     tags:
 *       - Streams
 *     summary: Create a new payment stream
 *     description: |
 *       Creates a new payment stream. This endpoint indexes the stream intention.
 *       The actual stream creation happens on-chain via Soroban smart contracts.
 *       
 *       **Sandbox Mode:**
 *       - Add header `X-Sandbox-Mode: true` or query parameter `?sandbox=true`
 *       - Sandbox responses include `_sandbox` metadata
 *       - Sandbox data is stored in a separate database
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
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - sender
 *               - recipient
 *               - tokenAddress
 *               - amount
 *               - duration
 *             properties:
 *               sender:
 *                 type: string
 *                 description: Sender's Stellar public key
 *                 example: "GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA"
 *               recipient:
 *                 type: string
 *                 description: Recipient's Stellar public key
 *                 example: "GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD"
 *               tokenAddress:
 *                 type: string
 *                 description: Token contract address
 *                 example: "CBCD789EFG012HIJ345KLM678NOP901QRS234TUV567WXY890ZAB123CDE"
 *               amount:
 *                 type: string
 *                 description: Total amount to stream (i128 as string)
 *                 example: "10000"
 *               duration:
 *                 type: integer
 *                 description: Stream duration in seconds
 *                 example: 86400
 *     responses:
 *       201:
 *         description: Stream created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Stream'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/', createStream);

/**
 * @openapi
 * /v1/streams:
 *   get:
 *     tags:
 *       - Streams
 *     summary: List streams
 *     description: Retrieve a list of payment streams, optionally filtered by sender or recipient.
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
 *     responses:
 *       200:
 *         description: List of streams
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Stream'
 */
router.get('/', listStreams);

/**
 * @openapi
 * /v1/streams/{streamId}:
 *   get:
 *     tags:
 *       - Streams
 *     summary: Get a single stream
 *     description: Retrieve detailed information about a specific stream by its on-chain ID.
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
 *     summary: List stream events (paginated)
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

export default router;
