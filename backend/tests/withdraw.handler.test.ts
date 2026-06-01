import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withdrawHandler } from '../src/routes/v1/streams/withdraw.js';
import { prisma } from '../src/lib/prisma.js';
import { claimableAmountService } from '../src/services/claimable.service.js';
import { withdraw as sorobanWithdraw } from '../src/services/sorobanService.js';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../src/types/auth.types.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    stream: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    streamEvent: {
      create: vi.fn(),
    },
  },
}));

vi.mock('../src/services/claimable.service.js', () => ({
  claimableAmountService: {
    getClaimableAmount: vi.fn(),
  },
}));

vi.mock('../src/services/sorobanService.js', () => ({
  withdraw: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('Withdraw Handler', () => {
  let req: Partial<AuthenticatedRequest>;
  let res: Partial<Response>;

  beforeEach(() => {
    vi.clearAllMocks();
    req = {
      params: { streamId: '123' },
      user: { publicKey: 'GRECIPIENT1' } as any,
    };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
  });

  it('should return 404 if stream not found', async () => {
    (prisma.stream.findUnique as any).mockResolvedValue(null);
    await withdrawHandler(req as AuthenticatedRequest, res as Response);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('should return 403 if caller is not recipient', async () => {
    (prisma.stream.findUnique as any).mockResolvedValue({ recipient: 'GOTHER' });
    await withdrawHandler(req as AuthenticatedRequest, res as Response);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('should successfully withdraw', async () => {
    const mockStream = {
      streamId: 123,
      recipient: 'GRECIPIENT1',
      withdrawnAmount: '0',
      depositedAmount: '1000',
      isActive: true,
    };
    (prisma.stream.findUnique as any).mockResolvedValue(mockStream);
    (claimableAmountService.getClaimableAmount as any).mockReturnValue({ actionable: true, claimableAmount: '100' });
    (sorobanWithdraw as any).mockResolvedValue({ txHash: 'tx123' });
    (prisma.stream.update as any).mockResolvedValue({ ...mockStream, withdrawnAmount: '100' });

    await withdrawHandler(req as AuthenticatedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, txHash: 'tx123' }));
    expect(prisma.streamEvent.create).toHaveBeenCalled();
  });
});
