import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../../../src/services/sse.service.js', () => ({
  sseService: {
    broadcastToStream: vi.fn(),
    broadcastToUser: vi.fn(),
  },
  SSEService: vi.fn(() => ({
    broadcastToStream: vi.fn(),
    broadcastToUser: vi.fn(),
  })),
}));

vi.mock('../../../src/services/sorobanService.js', () => ({
  submitSignedCancel: vi.fn().mockResolvedValue('tx_hash_123'),
  getStreamFromChain: vi.fn(),
  getClaimableFromChain: vi.fn(),
  isStale: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/lib/prisma.js', () => {
  const mockPrisma = {
    stream: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    streamEvent: {
      create: vi.fn(),
      upsert: vi.fn(),
    },
    $transaction: vi.fn(async (fn: any) => fn(mockPrisma)),
  };
  return {
    prisma: mockPrisma,
    default: mockPrisma,
  };
});

// Mock auth middleware to bypass real Stellar signature verification.
// Uses a simple factory (no importOriginal) so it is reliable with pool:forks.
vi.mock('../../../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/middleware/auth.js')>();
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      req.user = { publicKey: 'G_SENDER_123' };
      next();
    },
    requireAdmin: (_req: any, res: any, _next: any) => {
      res.status(403).json({ error: 'Forbidden' });
    },
  };
});

// ─── App import (after mocks) ───────────────────────────────────────────────

import app from '../../../src/app.js';
import * as sorobanService from '../../../src/services/sorobanService.js';
import { ApiError } from '../../../src/lib/api-error.js';
import { prisma } from '../../../src/lib/prisma.js';

// The envelope the sender's wallet produced from POST /v1/streams/simulate.
// `submitSignedCancel` is mocked here, so the handler only sees the string.
const SIGNED_XDR = 'AAAAAGV1nQJ2Z3F0dXliMG5jaGtoMnJkM2s0dHV2OHk=';
const relayArgs = (streamId: bigint) => [SIGNED_XDR, { streamId, senderAddress: 'G_SENDER_123' }];

describe('POST /v1/streams/:streamId/cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('successfully cancels an active stream when called by the sender', async () => {
    const streamId = 123;
    const mockStream = {
      streamId,
      sender: 'G_SENDER_123',
      isActive: true,
    };

    (prisma.stream.findUnique as any).mockResolvedValue(mockStream);
    (prisma.stream.update as any).mockResolvedValue({ ...mockStream, isActive: false });

    const res = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token')
      .send({ signedXdr: SIGNED_XDR });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      txHash: 'tx_hash_123',
      status: 'CANCELLED',
    });

    expect(sorobanService.submitSignedCancel).toHaveBeenCalledWith(...relayArgs(BigInt(streamId)));
    expect(prisma.stream.update).toHaveBeenCalledWith({
      where: { streamId: BigInt(streamId) },
      data: { isActive: false },
    });
    // Issue #1219: a provisional CANCELLED StreamEvent is written atomically
    // so the stream immediately matches the "cancelled" status filter.
    expect(prisma.streamEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          transactionHash_eventType: {
            transactionHash: 'tx_hash_123',
            eventType: 'CANCELLED',
          },
        },
        create: expect.objectContaining({
          streamId: BigInt(streamId),
          eventType: 'CANCELLED',
          transactionHash: 'tx_hash_123',
        }),
      }),
    );
  });

  it('returns 400 if signedXdr is not provided in the request body', async () => {
    const streamId = 123;
    const mockStream = {
      streamId,
      sender: 'G_SENDER_123',
      isActive: true,
    };

    (prisma.stream.findUnique as any).mockResolvedValue(mockStream);

    const res = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MISSING_SIGNED_XDR');
    expect(res.body.error.message).toContain('signedXdr');
    expect(sorobanService.submitSignedCancel).not.toHaveBeenCalled();
  });

  // ── issue #1845: no endpoint may be handed a wallet secret ──────────────

  it('rejects the legacy senderSecret field with a migration hint', async () => {
    const streamId = 123;
    (prisma.stream.findUnique as any).mockResolvedValue({
      streamId,
      sender: 'G_SENDER_123',
      isActive: true,
    });

    const res = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token')
      .send({ senderSecret: 'S_SECRET_123' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SENDER_SECRET_REMOVED');
    expect(res.body.error.details.migration).toContain('/v1/streams/simulate');
    expect(sorobanService.submitSignedCancel).not.toHaveBeenCalled();
    expect(prisma.stream.update).not.toHaveBeenCalled();
  });

  it('refuses a real-shaped secret key in body, query or header before the route runs', async () => {
    // The global rejectWalletSecrets guard answers these, not the cancel
    // handler — so the stream lookup must never happen.
    const streamId = 123;
    (prisma.stream.findUnique as any).mockResolvedValue({
      streamId,
      sender: 'G_SENDER_123',
      isActive: true,
    });
    const secret = Keypair.random().secret();

    const inBody = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token')
      .send({ senderSecret: secret });
    const inQuery = await request(app)
      .post(`/v1/streams/${streamId}/cancel?secret=${encodeURIComponent(secret)}`)
      .set('Authorization', 'Bearer dummy_token')
      .send({ signedXdr: SIGNED_XDR });
    const inHeader = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token')
      .set('x-sender-secret', secret)
      .send({ signedXdr: SIGNED_XDR });

    for (const res of [inBody, inQuery, inHeader]) {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('WALLET_SECRET_NOT_ACCEPTED');
      expect(JSON.stringify(res.body)).not.toContain(secret);
    }
    expect(prisma.stream.findUnique).not.toHaveBeenCalled();
    expect(sorobanService.submitSignedCancel).not.toHaveBeenCalled();
  });

  it('returns 400 and writes nothing when the envelope is not this cancel', async () => {
    const streamId = 123;
    (prisma.stream.findUnique as any).mockResolvedValue({
      streamId,
      sender: 'G_SENDER_123',
      isActive: true,
    });
    (sorobanService.submitSignedCancel as any).mockRejectedValue(
      new ApiError(400, 'SIGNED_TX_MISMATCH', 'The transaction cancels a different stream than requested.'),
    );

    const res = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token')
      .send({ signedXdr: SIGNED_XDR });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SIGNED_TX_MISMATCH');
    expect(prisma.stream.update).not.toHaveBeenCalled();
    expect(prisma.streamEvent.upsert).not.toHaveBeenCalled();
  });

  it('returns 403 if the caller is not the stream sender', async () => {
    const streamId = 123;
    const mockStream = {
      streamId,
      sender: 'G_DIFFERENT_SENDER',
      isActive: true,
    };

    (prisma.stream.findUnique as any).mockResolvedValue(mockStream);

    const res = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only the sender can cancel the stream',
    });
    expect(sorobanService.submitSignedCancel).not.toHaveBeenCalled();
  });

  it('returns 404 if the stream does not exist in DB', async () => {
    const streamId = 999;
    (prisma.stream.findUnique as any).mockResolvedValue(null);

    const res = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token');

    expect(res.status).toBe(404);
    expect(sorobanService.submitSignedCancel).not.toHaveBeenCalled();
  });

  it('returns 409 if the stream is already inactive', async () => {
    const streamId = 123;
    const mockStream = {
      streamId,
      sender: 'G_SENDER_123',
      isActive: false,
    };

    (prisma.stream.findUnique as any).mockResolvedValue(mockStream);

    const res = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token');

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('already cancelled');
  });

  it('handles concurrent cancel requests correctly', async () => {
    const streamId = 123;
    const mockStream = {
      streamId,
      sender: 'G_SENDER_123',
      isActive: true,
    };

    // Both requests observe the active stream, so each relays its own signed
    // transaction and marks the stream inactive.
    (prisma.stream.findUnique as any).mockResolvedValue(mockStream);
    (prisma.stream.update as any).mockResolvedValue({ ...mockStream, isActive: false });
    (sorobanService.submitSignedCancel as any).mockResolvedValue('tx_hash_123');

    // Run two concurrent cancel requests
    const promise1 = request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token')
      .send({ signedXdr: SIGNED_XDR });
    const promise2 = request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token')
      .send({ signedXdr: SIGNED_XDR });

    const [res1, res2] = await Promise.all([promise1, promise2]);

    // Both should return 200 with CANCELLED status
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body).toEqual({
      txHash: 'tx_hash_123',
      status: 'CANCELLED',
    });
    expect(res2.body).toEqual({
      txHash: 'tx_hash_123',
      status: 'CANCELLED',
    });

    // Each request relays its own transaction
    expect(sorobanService.submitSignedCancel).toHaveBeenCalledTimes(2);
    expect(sorobanService.submitSignedCancel).toHaveBeenCalledWith(...relayArgs(BigInt(streamId)));

    // Stream should be marked as inactive via the repository helper
    expect(prisma.stream.update).toHaveBeenCalledWith({
      where: { streamId: BigInt(streamId) },
      data: { isActive: false },
    });

    // Both responses should reference the same transaction hash
    expect(res1.body.txHash).toBe(res2.body.txHash);
  });
});
