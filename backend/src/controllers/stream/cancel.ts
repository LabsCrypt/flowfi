import type { Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import logger from '../../logger.js';
import * as sorobanService from '../../services/sorobanService.js';
import type { AuthenticatedRequest } from '../../types/auth.types.js';
import * as streamRepository from '../../repositories/stream.repository.js';
import { parseStreamId } from '../../lib/stream-id.js';
import { sendApiError } from '../../types/api-error.js';

/**
 * @openapi
 * /v1/streams/{streamId}/cancel:
 *   post:
 *     tags:
 *       - Streams
 *     summary: Cancel an active payment stream
 *     description: |
 *       Cancels an active payment stream on the Stellar network.
 *       Only the original sender can cancel the stream.
 *       Accrued tokens are sent to the recipient, and the remainder is refunded to the sender.
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
 *               type: object
 *               properties:
 *                 txHash:
 *                   type: string
 *                 status:
 *                   type: string
 *                   example: CANCELLED
 *       403:
 *         description: Forbidden - only sender can cancel
 *       404:
 *         description: Stream not found
 *       409:
 *         description: Stream already cancelled or completed
 */
export const cancelStreamHandler = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const streamIdParam = req.params.streamId;
    const callerAddress = req.user.publicKey;

    const streamId = Array.isArray(streamIdParam) ? streamIdParam[0] : streamIdParam;
    if (!streamId) {
      return sendApiError(res, 400, 'MISSING_STREAM_ID', 'Missing streamId parameter');
    }

    const parsedStreamId = parseStreamId(streamId);
    if (parsedStreamId === null) {
      return sendApiError(res, 400, 'INVALID_STREAM_ID', 'Invalid streamId parameter');
    }

    // 1. Fetch stream from DB
    const stream = await prisma.stream.findUnique({
      where: { streamId: parsedStreamId }
    });

    if (!stream) {
      return sendApiError(res, 404, 'NOT_FOUND', 'Stream not found');
    }

    // 2. Validate caller is sender
    if (stream.sender !== callerAddress) {
      return sendApiError(res, 403, 'FORBIDDEN', 'Only the sender can cancel the stream');
    }

    // 3. Check status
    if (!stream.isActive) {
      return sendApiError(res, 409, 'CONFLICT', 'Stream is already cancelled or completed');
    }

    // 4. Call Soroban service to cancel on-chain
    const secretKey = process.env.KEEPER_SECRET_KEY;
    if (!secretKey) {
      logger.error('[CancelStream] KEEPER_SECRET_KEY not configured');
      return sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'Backend not configured for on-chain calls');
    }

    const txHash = await sorobanService.cancelStream(parsedStreamId, senderSecret);

    // 5. Update DB record status using repository helper
    await streamRepository.updateStatus(parsedStreamId, 'CANCELLED');

    logger.info(`[CancelStream] Stream ${parsedStreamId} cancelled by ${callerAddress}. Tx: ${txHash}`);

    return res.status(200).json({ 
      txHash, 
      status: 'CANCELLED' 
    });
  } catch (error) {
    logger.error('Error cancelling stream:', error);
    if (error instanceof Error && error.message.includes('Simulation failed')) {
        return sendApiError(res, 400, 'TRANSACTION_SIMULATION_FAILED', error.message);
    }
    return sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'A technical error occurred. Please try again later.');
  }
};
