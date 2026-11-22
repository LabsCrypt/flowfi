import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withdrawHandler } from '../src/routes/v1/streams/withdraw.js';
import { prisma } from '../src/lib/prisma.js';
import { claimableAmountService } from '../src/services/claimable.service.js';
import { withdraw as sorobanWithdraw } from '../src/services/sorobanService.js';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../src/types/auth.types.js';

const mockTx = {
  $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
  stream: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    stream: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    streamEvent: {
      create: vi.fn(),
      upsert: vi.fn(),
    },
    $transaction: vi.fn(async (fn: any) => fn(mockTx)),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
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
    expect(res.json).toHaveBeenCalledWith({ error: { code: 'NOT_FOUND', message: 'Stream not found' } });
  });

  it('should return 403 if caller is not recipient', async () => {
    (prisma.stream.findUnique as any).mockResolvedValue({ recipient: 'GOTHER' });
    await withdrawHandler(req as AuthenticatedRequest, res as Response);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('simulates the withdrawal without touching any accounting', async () => {
    const mockStream = {
      streamId: 123,
      recipient: 'GRECIPIENT1',
      withdrawnAmount: '0',
      depositedAmount: '1000',
      isActive: true,
    };
    (prisma.stream.findUnique as any).mockResolvedValue(mockStream);
    (claimableAmountService.getClaimableAmount as any).mockReturnValue({ actionable: true, claimableAmount: '100' });
    // The service resolves with a hash from the dry-run; issue #1847 is that it
    // must never reach the client or the ledger book as if it were submitted.
    (sorobanWithdraw as any).mockResolvedValue({ txHash: 'tx123' });

    await withdrawHandler(req as AuthenticatedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, simulated: true, amount: '100' }),
    );
    const body = (res.json as any).mock.calls[0][0];
    expect(body).not.toHaveProperty('txHash');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.stream.update).not.toHaveBeenCalled();
    expect(prisma.streamEvent.upsert).not.toHaveBeenCalled();
    expect(prisma.streamEvent.create).not.toHaveBeenCalled();
  });
});
