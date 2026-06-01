import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cancelStreamHandler } from '../src/controllers/stream/cancel.js';
import { prisma } from '../src/lib/prisma.js';
import * as sorobanService from '../src/services/sorobanService.js';
import * as streamRepository from '../src/repositories/stream.repository.js';
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
  cancelStream: vi.fn(),
}));

vi.mock('../src/repositories/stream.repository.js', () => ({
  updateStatus: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('Cancel Stream Controller', () => {
  let req: Partial<AuthenticatedRequest>;
  let res: Partial<Response>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KEEPER_SECRET_KEY = 'SABC123';
    req = {
      params: { streamId: '123' },
      user: { publicKey: 'GSENDER1' } as any,
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

  it('should successfully cancel stream', async () => {
    (prisma.stream.findUnique as any).mockResolvedValue({ sender: 'GSENDER1', isActive: true });
    (sorobanService.cancelStream as any).mockResolvedValue('tx_hash_123');

    await cancelStreamHandler(req as AuthenticatedRequest, res as Response);

    expect(sorobanService.cancelStream).toHaveBeenCalledWith(123, 'SABC123');
    expect(streamRepository.updateStatus).toHaveBeenCalledWith(123, 'CANCELLED');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'CANCELLED', txHash: 'tx_hash_123' }));
  });

  it('should return 500 if KEEPER_SECRET_KEY is missing', async () => {
    delete process.env.KEEPER_SECRET_KEY;
    (prisma.stream.findUnique as any).mockResolvedValue({ sender: 'GSENDER1', isActive: true });

    await cancelStreamHandler(req as AuthenticatedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
