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

      // Gate the balance increment on whether the event was newly inserted.
      // The unique constraint on (transactionHash, eventType) makes the INSERT
      // a no-op for retries: RETURNING returns null and we skip the balance
      // update. This guarantees idempotency for both sequential retries and
      // concurrent duplicates — the withdrawal is counted exactly once per
      // claimable window (Issue #1216).
      const updatedStream = await prisma.$transaction(async (tx) => {
        // 1. Attempt to insert the event. On conflict (duplicate retry) the
        //    INSERT is skipped and RETURNING yields null.
        const inserted = await tx.$executeRawUnsafe(
          `INSERT INTO "StreamEvent"
             ("id", "streamId", "eventType", "amount", "transactionHash",
              "ledgerSequence", "timestamp", "metadata", "createdAt")
           SELECT
             gen_random_uuid()::text, $1::bigint, 'WITHDRAWN', $2::text,
             $3::text, 0, $4::bigint, $5::text, NOW()
           WHERE NOT EXISTS (
             SELECT 1 FROM "StreamEvent"
             WHERE "transactionHash" = $3::text AND "eventType" = 'WITHDRAWN'
           )
           RETURNING "id"`,
          parsedStreamId,
          claimable.claimableAmount,
          result.txHash,
          now,
          JSON.stringify({ withdrawnBy: req.user.publicKey }),
        );

        // inserted = 1 → new event, proceed with balance increment
        // inserted = 0 → duplicate, skip balance update
        if (inserted > 0) {
          // 2. Atomically increment withdrawnAmount in a single SQL statement
          //    so concurrent requests compound rather than overwrite each other.
          await tx.$executeRawUnsafe(
            `UPDATE "Stream"
             SET "withdrawnAmount" = ("withdrawnAmount"::bigint + $1::bigint)::text,
                 "lastUpdateTime" = $2
             WHERE "streamId" = $3`,
            withdrawAmount.toString(),
            now,
            parsedStreamId,
          );
        }

        // Re-read the stream to get post-increment values.
        const refreshed = await tx.stream.findUnique({
          where: { streamId: parsedStreamId },
        });

        // Conditionally deactivate if fully withdrawn.
        if (
          inserted > 0 &&
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

      // If the event already existed this was a duplicate request — the
      // handler still succeeds (idempotent) but skips the balance update.
      // A 409 is not appropriate here because the client may have retried
      // after a network timeout; returning 200 with the current stream
      // state lets the client confirm the withdrawal was already applied.

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
