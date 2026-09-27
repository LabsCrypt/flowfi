import { Router } from 'express';
import { getToken, listTokens } from '../../controllers/token.controller.js';
const router = Router();
/**
 * @openapi
 * /v1/tokens:
 *   get:
 *     tags: [Tokens]
 *     summary: List verified tokens
 *     responses:
 *       200:
 *         description: Verified token metadata
 */
router.get('/', listTokens);
/**
 * @openapi
 * /v1/tokens/{address}:
 *   get:
 *     tags: [Tokens]
 *     summary: Fetch or resolve token metadata by contract address
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Soroban contract address (C...)
 *     responses:
 *       200: { description: Resolved token metadata }
 *       400: { description: Invalid contract address }
 *       502: { description: Metadata could not be resolved from Stellar }
 */
router.get('/:address', getToken);
export default router;