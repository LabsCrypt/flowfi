import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cancelStreamHandler } from '../src/controllers/stream/cancel.js';
import { prisma } from '../src/lib/prisma.js';
import * as sorobanService from '../src/services/sorobanService.js';
import * as streamRepository from '../src/repositories/stream.repository.js';
import { ApiError } from '../src/lib/api-error.js';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../src/types/auth.types.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    stream: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../src/services/sorobanService.js', () => ({
  submitSignedCancel: vi.fn(),
}));

vi.mock('../src/repositories/stream.repository.js', () => ({
  updateStatus: vi.fn(),
  markCancelledProvisionally: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// A syntactically valid base64 envelope blob. The handler never parses it —
// `submitSignedCancel` is mocked — so only its presence and type matter here.
const SIGNED_XDR = 'AAAAAGV1nQJ2Z3F0dXliMG5jaGtoMnJkM2s0dHV2OHk=';
const MIGRATION_HINT = {
  migration:
    'POST /v1/streams/simulate { action: "cancel" } -> wallet.signTransaction(unsignedXdr) -> POST signedXdr here',
};

describe('Cancel Stream Controller', () => {
  let req: Partial<AuthenticatedRequest>;
  let res: Partial<Response>;

  beforeEach(() => {
    vi.clearAllMocks();
    req = {
      params: { streamId: '123' },
      user: { publicKey: 'GSENDER1' } as any,
      body: { signedXdr: SIGNED_XDR },
    };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
  });

  it('should return 404 if stream not found', async () => {
    (prisma.stream.findUnique as any).mockResolvedValue(null);

    await cancelStreamHandler(req as AuthenticatedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: { code: 'NOT_FOUND', message: 'Stream not found' } });
  });

  it('should return 403 if caller is not sender', async () => {
    (prisma.stream.findUnique as any).mockResolvedValue({ sender: 'GOTHER', isActive: true });

    await cancelStreamHandler(req as AuthenticatedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('should return 409 if stream is already inactive', async () => {
    (prisma.stream.findUnique as any).mockResolvedValue({ sender: 'GSENDER1', isActive: false });

    await cancelStreamHandler(req as AuthenticatedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('relays the wallet-signed envelope and records its real tx hash', async () => {
    (prisma.stream.findUnique as any).mockResolvedValue({ sender: 'GSENDER1', isActive: true });
    (sorobanService.submitSignedCancel as any).mockResolvedValue('tx_hash_123');

    await cancelStreamHandler(req as AuthenticatedRequest, res as Response);

    // The caller's address is taken from the authenticated token, never the body.
    expect(sorobanService.submitSignedCancel).toHaveBeenCalledWith(SIGNED_XDR, {
      streamId: 123n,
      senderAddress: 'GSENDER1',
    });
    expect(streamRepository.markCancelledProvisionally).toHaveBeenCalledWith(123n, 'tx_hash_123');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'CANCELLED', txHash: 'tx_hash_123' }));
  });

  // --- issue #1845: the backend must never be handed a wallet secret -------

  it('rejects a legacy senderSecret with a migration hint and submits nothing', async () => {
    (prisma.stream.findUnique as any).mockResolvedValue({ sender: 'GSENDER1', isActive: true });
    req.body = { senderSecret: 'SABC123' };

    await cancelStreamHandler(req as AuthenticatedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'SENDER_SECRET_REMOVED',
        message:
          'senderSecret is no longer accepted. Sign the simulated cancel transaction in your wallet and send it as signedXdr.',
        details: MIGRATION_HINT,
      },
    });
    expect(sorobanService.submitSignedCancel).not.toHaveBeenCalled();
    expect(streamRepository.markCancelledProvisionally).not.toHaveBeenCalled();
  });

  it('rejects senderSecret even when paired with a valid signedXdr', async () => {
    (prisma.stream.findUnique as any).mockResolvedValue({ sender: 'GSENDER1', isActive: true });
    req.body = { signedXdr: SIGNED_XDR, senderSecret: 'SABC123' };

    await cancelStreamHandler(req as AuthenticatedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json as any).mock.calls[0][0].error.code).toBe('SENDER_SECRET_REMOVED');
    expect(sorobanService.submitSignedCancel).not.toHaveBeenCalled();
  });

  it('never echoes the submitted secret back in the response', async () => {
    (prisma.stream.findUnique as any).mockResolvedValue({ sender: 'GSENDER1', isActive: true });
    req.body = { senderSecret: 'SABCDEFGHIJKLMNOPQRSTUVWXYZ2345678901234567890' };

    await cancelStreamHandler(req as AuthenticatedRequest, res as Response);

    expect(JSON.stringify((res.json as any).mock.calls)).not.toContain(
      'SABCDEFGHIJKLMNOPQRSTUVWXYZ2345678901234567890',
    );
  });

  it('returns 400 when signedXdr is missing from the request body', async () => {
    req.body = {};
    (prisma.stream.findUnique as any).mockResolvedValue({ sender: 'GSENDER1', isActive: true });

    await cancelStreamHandler(req as AuthenticatedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'MISSING_SIGNED_XDR',
        message:
          'signedXdr is required: sign the cancel transaction from POST /v1/streams/simulate and send the base64 envelope.',
      },
    });
    expect(sorobanService.submitSignedCancel).not.toHaveBeenCalled();
  });

  it('returns 400 when signedXdr is blank or not a string', async () => {
    (prisma.stream.findUnique as any).mockResolvedValue({ sender: 'GSENDER1', isActive: true });

    for (const body of [{ signedXdr: '   ' }, { signedXdr: 42 }, {}]) {
      req.body = body;
      await cancelStreamHandler(req as AuthenticatedRequest, res as Response);
    }

    expect(res.status).toHaveBeenCalledTimes(3);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(sorobanService.submitSignedCancel).not.toHaveBeenCalled();
  });

  // --- envelope validation failures come back as ApiError from the service --

  it('returns the service 400 and writes nothing when the envelope is not this cancel', async () => {
    (prisma.stream.findUnique as any).mockResolvedValue({ sender: 'GSENDER1', isActive: true });
    (sorobanService.submitSignedCancel as any).mockRejectedValue(
      new ApiError(400, 'SIGNED_TX_MISMATCH', 'The transaction cancels a different stream than requested.', {
        expected: '123',
        actual: '124',
      })
    );

    await cancelStreamHandler(req as AuthenticatedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'SIGNED_TX_MISMATCH',
        message: 'The transaction cancels a different stream than requested.',
        details: { expected: '123', actual: '124' },
      },
    });
    expect(streamRepository.markCancelledProvisionally).not.toHaveBeenCalled();
  });

  it('leaves DB unchanged and does not update status when the relayed transaction fails on-chain', async () => {
    (prisma.stream.findUnique as any).mockResolvedValue({ sender: 'GSENDER1', isActive: true });
    (sorobanService.submitSignedCancel as any).mockRejectedValue(
      new Error('Transaction failed on-chain: tx_fail_post_submission')
    );

    await cancelStreamHandler(req as AuthenticatedRequest, res as Response);

    expect(sorobanService.submitSignedCancel).toHaveBeenCalledWith(SIGNED_XDR, {
      streamId: 123n,
      senderAddress: 'GSENDER1',
    });
    expect(streamRepository.markCancelledProvisionally).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
