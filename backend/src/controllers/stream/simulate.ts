import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../lib/api-error.js';
import logger from '../../logger.js';
import { simulateStreamAction, type StreamAction } from '../../services/sorobanService.js';

/**
 * Request schema for POST /api/v1/streams/simulate.
 *
 * `params` is intentionally a single loose object: which fields are required
 * depends on the action (see `buildInvocations` in sorobanService.ts), and
 * modelling every action as its own discriminated union here would only move
 * the same rules into two places. Per-action requirements are validated in the
 * service so they can never drift from the contract ABI.
 */
const simulateBodySchema = z.object({
  action: z.enum(['create', 'withdraw', 'cancel', 'top_up', 'batch_withdraw']),
  senderPublicKey: z.string().min(1),
  params: z
    .object({
      streamId: z.string().optional(),
      streamIds: z.array(z.string()).optional(),
      recipient: z.string().optional(),
      amount: z.string().optional(),
      duration: z.number().int().positive().optional(),
      tokenAddress: z.string().optional(),
    })
    .default({}),
});

/**
 * @openapi
 * /v1/streams/simulate:
 *   post:
 *     tags: [Streams]
 *     summary: Simulate a stream contract call
 *     description: |
 *       Runs a Soroban `simulateTransaction` for the requested action and
 *       returns an unsigned transaction with the ledger footprint, resource
 *       limits and a padded resource fee already applied — ready for a
 *       browser wallet (Freighter, Lobstr, xBull) to sign.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [action, senderPublicKey]
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [create, withdraw, cancel, top_up, batch_withdraw]
 *               senderPublicKey:
 *                 type: string
 *               params:
 *                 type: object
 *     responses:
 *       200:
 *         description: Simulation succeeded
 *       400:
 *         description: Invalid parameters or a reverted simulation
 *       503:
 *         description: Stream contract is not configured
 */
export const simulateStreamHandler = async (req: Request, res: Response) => {
  const parsed = simulateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Validation error',
      code: 'invalid_params',
      details: parsed.error.issues,
    });
  }

  const { action, senderPublicKey, params } = parsed.data;

  try {
    const data = await simulateStreamAction(action as StreamAction, senderPublicKey, params);
    return res.status(200).json({ success: true, data });
  } catch (err) {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        error: err.message,
        code: err.code,
        ...(err.details ? { details: err.details } : {}),
      });
    }

    logger.error(`[simulate] Unexpected failure for action ${action}:`, err);
    return res.status(500).json({
      error: 'Simulation failed',
      code: 'simulation_error',
    });
  }
};
