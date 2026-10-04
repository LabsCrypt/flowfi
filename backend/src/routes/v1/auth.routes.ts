import { Router } from 'express';
import { issueChallenge, verifyChallenge } from '../../middleware/auth.js';

const router = Router();

/**
 * @openapi
 * /v1/auth/challenge:
 *   post:
 *     tags: [Auth]
 *     summary: Request a sign challenge for wallet authentication
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [publicKey]
 *             properties:
 *               publicKey:
 *                 type: string
 *                 example: GABC...
 *     responses:
 *       200:
 *         description: Challenge nonce issued
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthChallengeResponse'
 *       400:
 *         description: Invalid publicKey
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Too many requests
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/challenge', issueChallenge);

/**
 * @openapi
 * /v1/auth/verify:
 *   post:
 *     tags: [Auth]
 *     summary: Verify signed challenge and receive JWT
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [publicKey, signedTransaction]
 *             properties:
 *               publicKey:
 *                 type: string
 *               signedTransaction:
 *                 type: string
 *                 description: Base64-encoded XDR signed transaction containing the nonce
 *     responses:
 *       200:
 *         description: JWT token
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthVerifyResponse'
 *       400:
 *         description: Missing publicKey or signedTransaction
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Invalid signature or expired challenge
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Too many requests
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/verify', verifyChallenge);

export default router;
