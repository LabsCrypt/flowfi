import type { Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import logger from '../../logger.js';
import * as sorobanService from '../../services/sorobanService.js';
import type { AuthenticatedRequest } from '../../types/auth.types.js';
import * as streamRepository from '../../repositories/stream.repository.js';

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
      return res.status(400).json({ error: 'Missing streamId parameter' });
    }

  const parsedStreamId = parseInt(streamId, 10);

   // 1. Fetch stream from DB
    const stream = await prisma.stream.findUnique({
      where: { streamId: parsedStreamId }
    });

    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    // 2. Validate caller is sender
    if (stream.sender !== callerAddress) {
      return res.status(403).json({ 
        error: 'Forbidden', 
        message: 'Only the sender can cancel the stream' 
      });
    }

    // 3. Check status
    if (!stream.isActive) {
      return res.status(409).json({ 
        error: 'Conflict', 
        message: 'Stream is already cancelled or completed' 
      });
    }

    // 4. Call Soroban service to cancel on-chain
    const secretKey = process.env.SOROBAN_SECRET_KEY;
    if (!secretKey) {
      logger.error('[CancelStream] SOROBAN_SECRET_KEY not configured');
      return res.status(500).json({ error: 'Internal server error', message: 'Backend not configured for on-chain calls' });
    }

    const txHash = await sorobanService.cancelStream(parsedStreamId, secretKey);

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
        return res.status(400).json({ error: 'Transaction simulation failed', message: error.message });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
};
