import type { Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import logger from '../../logger.js';
import * as sorobanService from '../../services/sorobanService.js';
import type { AuthenticatedRequest } from '../../types/auth.types.js';
import * as streamRepository from '../../repositories/stream.repository.js';
import { parseStreamId } from '../../lib/stream-id.js';
import { ApiError, sendApiError } from '../../lib/api-error.js';

/**
 * @openapi
 * /v1/streams/{streamId}/cancel:
 *   post:
 *     tags:
 *       - Streams
 *     summary: Cancel an active payment stream with a wallet-signed transaction
 *     description: |
 *       Broadcasts the cancel transaction the caller's wallet already signed and
 *       records the cancellation. Only the original sender can cancel their
 *       stream; accrued tokens go to the recipient and the remainder is refunded
 *       to the sender.
 *
 *       Signing happens in the wallet. `POST /v1/streams/simulate` with
 *       `action: "cancel"` returns an unsigned, footprint-annotated XDR; the
 *       wallet signs those exact bytes and the signature is posted here as
 *       `signedXdr`. The API no longer accepts `senderSecret` (issue #1845) —
 *       a request that still carries one is rejected.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: streamId
 *         required: true
 *         schema:
 *           type: integer
 *         description: On-chain stream ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [signedXdr]
 *             properties:
 *               signedXdr:
 *                 type: string
 *                 description: base64 `TransactionEnvelope` returned by the wallet, signing the simulated cancel transaction
 *     responses:
 *       200:
 *         description: Stream cancelled on-chain
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CancelResponse'
 *       400:
 *         description: Missing/invalid signedXdr, a legacy senderSecret, or an envelope that is not this stream's cancel
 *       401:
 *         description: Unauthorized - missing or invalid authentication
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

    // 4. Broadcast the caller's wallet-signed cancel. The backend signs nothing
    // and holds no user key: it only relays bytes the sender already signed
    // (issue #1845). `senderSecret` is rejected outright.
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'senderSecret')) {
      return sendApiError(
        res,
        400,
        'SENDER_SECRET_REMOVED',
        'senderSecret is no longer accepted. Sign the simulated cancel transaction in your wallet and send it as signedXdr.',
        { migration: 'POST /v1/streams/simulate { action: "cancel" } -> wallet.signTransaction(unsignedXdr) -> POST signedXdr here' },
      );
    }

    const signedXdr = req.body?.signedXdr;
    if (typeof signedXdr !== 'string' || signedXdr.trim() === '') {
      return sendApiError(
        res,
        400,
        'MISSING_SIGNED_XDR',
        'signedXdr is required: sign the cancel transaction from POST /v1/streams/simulate and send the base64 envelope.',
      );
    }

    const txHash = await sorobanService.submitSignedCancel(signedXdr, {
      streamId: parsedStreamId,
      senderAddress: callerAddress,
    });

    // 5. Update DB record status and write a provisional CANCELLED StreamEvent
    // atomically (issue #1219) so the stream shows up under the "cancelled"
    // filter before the indexer has processed the on-chain event.
    await streamRepository.markCancelledProvisionally(parsedStreamId, txHash);

    logger.info(`[CancelStream] Stream ${parsedStreamId} cancelled by ${callerAddress}. Tx: ${txHash}`);

    return res.status(200).json({ 
      txHash, 
      status: 'CANCELLED' 
    });
  } catch (error) {
    logger.error('Error cancelling stream:', error);
    if (error instanceof ApiError) {
      return sendApiError(res, error.statusCode, error.code, error.message, error.details);
    }
    return sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'A technical error occurred. Please try again later.');
  }
};
