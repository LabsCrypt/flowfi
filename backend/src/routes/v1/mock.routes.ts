/**
 * Mock mode routes (issue #1336)
 *
 * Local-only endpoints that let the sandbox UI sign in and mutate stream state
 * without a wallet or a live network. The router is mounted only when
 * `isMockMode()` is true, and `isMockMode()` is hard-disabled in production, so
 * these routes cannot exist on a real deployment.
 */

import { Router, type Response } from 'express';
import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';
import { isMockMode, MOCK_TOKEN_EXPIRY_SECONDS } from '../../config/mock-mode.js';
import { requireAuth, signJwt } from '../../middleware/auth.js';
import { prisma } from '../../lib/prisma.js';
import logger from '../../logger.js';
import {
  applyMockAction,
  logMockAction,
  MOCK_ACTIONS,
  type MockAction,
} from '../../services/mock-chain.service.js';
import type { AuthenticatedRequest } from '../../types/auth.types.js';
import { sendApiError } from '../../types/api-error.js';
import { ApiError } from '../../lib/api-error.js';

const router = Router();

const JWT_ISSUER = process.env.JWT_ISSUER || 'flowfi-api';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'flowfi-api';

/**
 * Optional friendly names for the seeded accounts, e.g.
 * `MOCK_USER_LABELS="Ada,Bob,Cy,Dee,Eve"`. Falls back to "Mock account N" so
 * the wallet picker stays readable without any extra configuration.
 */
const MOCK_USER_LABELS = (process.env.MOCK_USER_LABELS ?? '')
  .split(',')
  .map((label) => label.trim())
  .filter(Boolean);

/**
 * @openapi
 * /v1/mock/users:
 *   get:
 *     tags: [Mock]
 *     summary: List seeded sandbox accounts (mock mode only)
 *     responses:
 *       200:
 *         description: Accounts available for mock sign-in
 *       404:
 *         description: Mock mode is not enabled
 */
router.get('/users', async (_req, res: Response) => {
  if (!isMockMode()) {
    return sendApiError(res, 404, 'not_found', 'Mock mode is not enabled');
  }

  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    take: 20,
    select: { publicKey: true, createdAt: true },
  });

  return res.status(200).json({
    users: users.map((user, index) => ({
      publicKey: user.publicKey,
      label: MOCK_USER_LABELS[index] ?? `Mock account ${index + 1}`,
    })),
  });
});

const authBodySchema = z.object({
  publicKey: z.string(),
});

/**
 * @openapi
 * /v1/mock/auth:
 *   post:
 *     tags: [Mock]
 *     summary: Issue a sandbox JWT for a seeded account (mock mode only)
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
 *     responses:
 *       200:
 *         description: Mock session token
 *       400:
 *         description: Invalid public key
 *       404:
 *         description: Mock mode is not enabled
 */
router.post('/auth', async (req, res: Response) => {
  if (!isMockMode()) {
    return sendApiError(res, 404, 'not_found', 'Mock mode is not enabled');
  }

  const parsed = authBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return sendApiError(res, 400, 'invalid_request', 'publicKey is required');
  }

  const { publicKey } = parsed.data;
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    return sendApiError(res, 400, 'invalid_public_key', 'publicKey is not a valid Stellar address');
  }

  const now = Math.floor(Date.now() / 1000);
  const token = signJwt({
    sub: publicKey,
    iat: now,
    exp: now + MOCK_TOKEN_EXPIRY_SECONDS,
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    mock: true,
  });

  return res.status(200).json({ token, expiresIn: MOCK_TOKEN_EXPIRY_SECONDS, mock: true });
});

const actionBodySchema = z.object({
  action: z.enum([...MOCK_ACTIONS] as [MockAction, ...MockAction[]]),
  params: z
    .object({
      streamId: z.string().optional(),
      streamIds: z.array(z.string()).optional(),
      recipient: z.string().optional(),
      tokenAddress: z.string().optional(),
      amount: z.string().optional(),
      duration: z.number().int().optional(),
    })
    .optional(),
});

/**
 * @openapi
 * /v1/mock/actions:
 *   post:
 *     tags: [Mock]
 *     summary: Apply a stream action locally instead of on-chain (mock mode only)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action]
 *             properties:
 *               action:
 *                 type: string
 *                 enum:
 *                   [create_stream, top_up_stream, cancel_stream, withdraw, batch_withdraw, pause_stream, resume_stream]
 *               params:
 *                 type: object
 *     responses:
 *       200:
 *         description: Action applied
 *       400:
 *         description: Invalid action or parameters
 *       401:
 *         description: Missing or invalid mock token
 *       409:
 *         description: Action conflicts with the current stream state
 */
router.post('/actions', requireAuth, (async (req: AuthenticatedRequest, res: Response) => {
  if (!isMockMode()) {
    return sendApiError(res, 404, 'not_found', 'Mock mode is not enabled');
  }

  const parsed = actionBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return sendApiError(
      res,
      400,
      'invalid_request',
      `action must be one of: ${MOCK_ACTIONS.join(', ')}`,
    );
  }

  try {
    const result = await applyMockAction(
      parsed.data.action,
      req.user.publicKey,
      parsed.data.params ?? {},
    );
    logMockAction(parsed.data.action, req.user.publicKey, result);
    return res.status(200).json(result);
  } catch (error) {
    // Domain rejections (ownership, state, bad params) carry a deliberate
    // status/code from mock-chain.service; anything else is a genuine bug.
    if (error instanceof ApiError) {
      return sendApiError(res, error.status, error.code, error.message);
    }
    logger.error('[MockMode] action failed:', error);
    return sendApiError(res, 500, 'internal_error', 'Mock action failed');
  }
}) as any);

export default router;