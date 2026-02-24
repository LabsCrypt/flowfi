import { Router } from 'express';
import { createStream } from '../../controllers/stream.controller.js';

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

export default router;
