import type { Response } from 'express';
import { prisma } from '../../../lib/prisma.js';
import logger from '../../../logger.js';
import { claimableAmountService } from '../../../services/claimable.service.js';
import { withdraw as sorobanWithdraw } from '../../../services/sorobanService.js';
import type { AuthenticatedRequest } from '../../../types/auth.types.js';
import { parseStreamId } from '../../../lib/stream-id.js';

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
      return res.status(400).json({ error: 'Invalid streamId parameter' });
    }

    const stream = await prisma.stream.findUnique({
      where: { streamId: parsedStreamId },
      select: {
        streamId: true,
        sender: true,
        recipient: true,
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
      return res.status(404).json({ error: 'Stream not found' });
    }

    // Verify the caller is the stream recipient
    if (stream.recipient !== req.user.publicKey) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Only the stream recipient can withdraw from the stream',
      });
    }

    const claimable = claimableAmountService.getClaimableAmount(stream);

    if (!claimable.actionable) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'No claimable balance is currently available',
      });
    }

    try {
      // Call Soroban service
      const result = await sorobanWithdraw(parsedStreamId, req.user.publicKey);
      
      const now = BigInt(Math.floor(Date.now() / 1000));
      const withdrawAmount = BigInt(claimable.claimableAmount);

      // Use raw SQL atomic increment to prevent concurrent withdraw requests
      // from losing updates (Issue #1217 — read-compute-write race).
      // Prisma's built-in { increment } is unavailable on String-typed columns,
      // so we use $transaction with $executeRawUnsafe for atomic SQL updates.
      const updatedStream = await prisma.$transaction(async (tx) => {
        // Atomically increment withdrawnAmount in a single SQL statement so
        // concurrent requests compound rather than overwrite each other.
        await tx.$executeRawUnsafe(
          `UPDATE "Stream" SET "withdrawnAmount" = ("withdrawnAmount"::bigint + $1::bigint)::text, "lastUpdateTime" = $2 WHERE "streamId" = $3`,
          withdrawAmount.toString(),
          now,
          parsedStreamId,
        );

        // Re-read the stream to get post-increment values.
        const refreshed = await tx.stream.findUnique({
          where: { streamId: parsedStreamId },
        });

        // Conditionally deactivate if fully withdrawn.
        if (
          stream.isActive &&
          refreshed &&
          BigInt(refreshed.withdrawnAmount) >= BigInt(refreshed.depositedAmount)
        ) {
          await tx.stream.update({
            where: { streamId: parsedStreamId },
            data: { isActive: false },
          });
          refreshed.isActive = false;
        }

        return refreshed;
      });

      // Create or update a WITHDRAWN event
      await prisma.streamEvent.upsert({
        where: {
          transactionHash_eventType: {
            transactionHash: result.txHash,
            eventType: 'WITHDRAWN',
          },
        },
        create: {
          streamId: parsedStreamId,
          eventType: 'WITHDRAWN',
          amount: claimable.claimableAmount,
          transactionHash: result.txHash,
          ledgerSequence: 0,
          timestamp: now,
          metadata: JSON.stringify({ withdrawnBy: req.user.publicKey }),
        },
        update: {},
      });

      logger.info(`Stream ${parsedStreamId} withdrawn by ${req.user.publicKey}`);

      return res.status(200).json({
        success: true,
        streamId: parsedStreamId,
        txHash: result.txHash,
        amount: claimable.claimableAmount,
        stream: updatedStream,
      });
    } catch (sorobanError) {
      logger.error(`Soroban withdraw failed for stream ${parsedStreamId}:`, sorobanError);
      return res.status(400).json({
        error: 'Failed to withdraw from stream on chain',
        message: sorobanError instanceof Error ? sorobanError.message : 'Unknown error',
      });
    }
  } catch (error) {
    logger.error('Error withdrawing from stream:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
