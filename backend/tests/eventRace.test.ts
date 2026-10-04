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

describe('Action Controller vs Worker Event Write Race Guard (Issue #831)', () => {
  let req: Partial<AuthenticatedRequest>;
  let res: Partial<Response>;

  beforeEach(() => {
    vi.clearAllMocks();
    req = {
      params: { streamId: '100' },
      user: { publicKey: 'GRECIPIENT' } as any,
    };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
  });

  it('withdrawHandler uses upsert on transactionHash_eventType preventing P2002 duplicate crashes when worker processes event first', async () => {
    const mockStream = {
      streamId: 100n,
      recipient: 'GRECIPIENT',
      withdrawnAmount: '0',
      depositedAmount: '1000',
      isActive: true,
    };
    (prisma.stream.findUnique as any).mockResolvedValue(mockStream);
    (claimableAmountService.getClaimableAmount as any).mockReturnValue({ actionable: true, claimableAmount: '500' });
    (sorobanWithdraw as any).mockResolvedValue({ txHash: 'tx_race_123' });
    // Mock the $transaction to return the refreshed stream
    vi.mocked(prisma.$transaction as any).mockImplementation(async (fn: any) => {
      mockTx.stream.findUnique.mockResolvedValue({ ...mockStream, withdrawnAmount: '500' });
      return fn(mockTx);
    });
    (prisma.streamEvent.upsert as any).mockResolvedValue({ id: 'evt_1' });

    await withdrawHandler(req as AuthenticatedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(prisma.streamEvent.upsert).toHaveBeenCalledWith({
      where: {
        transactionHash_eventType: {
          transactionHash: 'tx_race_123',
          eventType: 'WITHDRAWN',
        },
      },
      create: expect.objectContaining({
        streamId: 100n,
        eventType: 'WITHDRAWN',
        transactionHash: 'tx_race_123',
      }),
      update: {},
    });
  });
});
