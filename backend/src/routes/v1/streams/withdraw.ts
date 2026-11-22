import type { Response } from 'express';
import { prisma } from '../../../lib/prisma.js';
import logger from '../../../logger.js';
import { claimableAmountService } from '../../../services/claimable.service.js';
import { withdraw as sorobanWithdraw } from '../../../services/sorobanService.js';
import type { AuthenticatedRequest } from '../../../types/auth.types.js';
import { parseStreamId } from '../../../lib/stream-id.js';
import { sendApiError } from '../../../lib/api-error.js';

/**
 * @openapi
 * /v1/streams/{streamId}/withdraw:
 *   post:
 *     tags:
 *       - Streams
 *     summary: Dry-run a withdrawal of the claimable balance
 *     description: |
 *       Verifies that a withdrawal of the currently claimable amount would
 *       succeed on-chain. Only the stream recipient may call it.
 *
 *       Nothing is submitted and nothing is written: `withdraw` is authorized by
 *       the recipient's wallet, so the backend cannot perform it on their
 *       behalf. Sign the XDR from `POST /v1/streams/simulate`
 *       (`action: "withdraw"`) to actually move funds; the indexer then records
 *       the WITHDRAWN event and updates `withdrawnAmount` from the confirmed
 *       on-chain event (issue #1847).
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
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
 *         description: Withdrawal verified as possible (simulated - no funds moved)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/WithdrawResponse'
 *       400:
 *         description: Invalid streamId or contract revert
 *       401:
 *         description: Unauthorized - missing or invalid authentication
 *       403:
 *         description: Forbidden - caller is not the stream recipient
 *       404:
 *         description: Stream not found
 *       409:
 *         description: Conflict - no claimable balance available
 *       500:
 *         description: Internal server error
 */
export const withdrawHandler = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const streamIdParam = Array.isArray(req.params.streamId)
      ? req.params.streamId[0]
      : req.params.streamId;
    const parsedStreamId = parseStreamId(streamIdParam);

    if (parsedStreamId === null) {
      return sendApiError(res, 400, 'INVALID_STREAM_ID', 'Invalid streamId parameter');
    }

    const stream = await prisma.stream.findUnique({
      where: { streamId: parsedStreamId },
      select: {
        streamId: true,
        sender: true,
        recipient: true,
        tokenAddress: true,
        ratePerSecond: true,
        depositedAmount: true,
        withdrawnAmount: true,
        startTime: true,
        lastUpdateTime: true,
        isActive: true,
        isPaused: true,
        pausedAt: true,
        totalPausedDuration: true,
        updatedAt: true,
      },
    });

    if (!stream) {
      return sendApiError(res, 404, 'NOT_FOUND', 'Stream not found');
    }

    // Verify the caller is the stream recipient
    if (stream.recipient !== req.user.publicKey) {
      return sendApiError(res, 403, 'FORBIDDEN', 'Only the stream recipient can withdraw from the stream');
    }

    const claimable = claimableAmountService.getClaimableAmount(stream);

    if (!claimable.actionable) {
      return sendApiError(res, 409, 'CONFLICT', 'No claimable balance is currently available');
    }

    try {
      // Read-only simulation: proves the recipient could withdraw right now.
      // No accounting is touched — the indexer is the only writer of
      // `withdrawnAmount` and WITHDRAWN events, because only a confirmed
      // on-chain event proves funds moved (issue #1847).
      await sorobanWithdraw(parsedStreamId, req.user.publicKey);

      logger.info(
        `Stream ${parsedStreamId} withdraw simulated for ${req.user.publicKey}`,
      );

      return res.status(200).json({
        success: true,
        simulated: true,
        streamId: parsedStreamId,
        amount: claimable.claimableAmount,
        message:
          'Withdrawal is available but was not submitted. Sign the simulated withdraw transaction with the recipient wallet; the indexer records it once it lands on chain.',
      });
    } catch (sorobanError) {
      logger.error(`Soroban withdraw simulation failed for stream ${parsedStreamId}:`, sorobanError);
      return sendApiError(res, 400, 'WITHDRAWAL_FAILED', 'Failed to withdraw from stream on chain');
    }
  } catch (error) {
    logger.error('Error withdrawing from stream:', error);
    return sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'A technical error occurred. Please try again later.');
  }
};
