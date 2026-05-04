import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

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
  cancelStream: vi.fn().mockResolvedValue('tx_hash_123'),
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
    },
  };
  return {
    prisma: mockPrisma,
    default: mockPrisma,
  };
});

// Mock auth middleware to bypass real Stellar signature verification
vi.mock('../../../src/middleware/auth.middleware.js', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.user = { publicKey: 'G_SENDER_123' };
    next();
  },
}));

// ─── App import (after mocks) ───────────────────────────────────────────────

import app from '../../../src/app.js';
import * as sorobanService from '../../../src/services/sorobanService.js';
import { prisma } from '../../../src/lib/prisma.js';

describe('POST /v1/streams/:streamId/cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SOROBAN_SECRET_KEY = 'S_SECRET_123';
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
      .set('Authorization', 'Bearer dummy_token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      txHash: 'tx_hash_123',
      status: 'CANCELLED',
    });

    expect(sorobanService.cancelStream).toHaveBeenCalledWith(streamId, 'S_SECRET_123');
    expect(prisma.stream.update).toHaveBeenCalledWith({
      where: { streamId },
      data: { isActive: false },
    });
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
    expect(res.body.error).toBe('Forbidden');
    expect(sorobanService.cancelStream).not.toHaveBeenCalled();
  });

  it('returns 404 if the stream does not exist in DB', async () => {
    const streamId = 999;
    (prisma.stream.findUnique as any).mockResolvedValue(null);

    const res = await request(app)
      .post(`/v1/streams/${streamId}/cancel`)
      .set('Authorization', 'Bearer dummy_token');

    expect(res.status).toBe(404);
    expect(sorobanService.cancelStream).not.toHaveBeenCalled();
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
    expect(res.body.message).toContain('already cancelled');
  });
});
