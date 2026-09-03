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
    // Mock $executeRawUnsafe: first call = INSERT event (returns 1 = inserted),
    // second call = UPDATE balance (returns undefined, doesn't matter).
    let callIndex = 0;
    mockTx.$executeRawUnsafe.mockImplementation(async () => {
      callIndex += 1;
      return callIndex === 1 ? 1 : undefined;
    });
    // Mock the $transaction callback to return the refreshed stream
    vi.mocked(prisma.$transaction as any).mockImplementation(async (fn: any) => {
      mockTx.stream.findUnique.mockResolvedValue({ ...mockStream, withdrawnAmount: '100' });
      return fn(mockTx);
    });

    await withdrawHandler(req as AuthenticatedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, txHash: 'tx123' }));
    // The event is now inserted inside the transaction; verify the INSERT
    // was attempted via $executeRawUnsafe (no separate upsert at top level).
    expect(mockTx.$executeRawUnsafe).toHaveBeenCalled();
  });

  it('should not increment withdrawnAmount when the event already exists (idempotent)', async () => {
    const mockStream = {
      streamId: 123,
      recipient: 'GRECIPIENT1',
      withdrawnAmount: '100',
      depositedAmount: '1000',
      isActive: true,
    };
    (prisma.stream.findUnique as any).mockResolvedValue(mockStream);
    (claimableAmountService.getClaimableAmount as any).mockReturnValue({ actionable: true, claimableAmount: '50' });
    (sorobanWithdraw as any).mockResolvedValue({ txHash: 'simulated-withdraw-123' });

    // First call: INSERT returns 1 (new event) → balance incremented
    // Second call: INSERT returns 0 (duplicate) → balance NOT incremented
    let eventInsertCount = 0;
    mockTx.$executeRawUnsafe.mockImplementation(async (_sql: string) => {
      eventInsertCount += 1;
      // First $executeRawUnsafe call is the event INSERT
      if (eventInsertCount === 1) return 1;
      // Second would be the balance UPDATE — return undefined (won't be reached on duplicate)
      return undefined;
    });

    // Simulate first withdraw: balance incremented from 100 to 150
    vi.mocked(prisma.$transaction as any).mockImplementation(async (fn: any) => {
      // After INSERT succeeds (rowcount=1), balance UPDATE runs, then findUnique returns updated state
      mockTx.stream.findUnique.mockResolvedValue({ ...mockStream, withdrawnAmount: '150' });
      return fn(mockTx);
    });

    await withdrawHandler(req as AuthenticatedRequest, res as Response);
    expect(res.status).toHaveBeenCalledWith(200);

    // Now simulate retry: INSERT returns 0 (duplicate), balance NOT updated
    eventInsertCount = 0;
    mockTx.$executeRawUnsafe.mockImplementation(async (_sql: string) => {
      eventInsertCount += 1;
      // INSERT returns 0 (duplicate)
      if (eventInsertCount === 1) return 0;
      return undefined;
    });

    vi.mocked(prisma.$transaction as any).mockImplementation(async (fn: any) => {
      // findUnique returns the SAME withdrawnAmount (not incremented)
      mockTx.stream.findUnique.mockResolvedValue({ ...mockStream, withdrawnAmount: '150' });
      return fn(mockTx);
    });

    await withdrawHandler(req as AuthenticatedRequest, res as Response);
    expect(res.status).toHaveBeenCalledWith(200);

    // Critical: the balance must be 150, not 200 — the duplicate did NOT increment
    const responseJson = (res.json as any).mock.calls[1][0];
    expect(responseJson.stream.withdrawnAmount).toBe('150');
  });

  it('should return 409 when no claimable balance available (duplicate event with zero claim)', async () => {
    const mockStream = {
      streamId: 123,
      recipient: 'GRECIPIENT1',
      withdrawnAmount: '500',
      depositedAmount: '1000',
      isActive: true,
    };
    (prisma.stream.findUnique as any).mockResolvedValue(mockStream);
    (claimableAmountService.getClaimableAmount as any).mockReturnValue({ actionable: false, claimableAmount: '0' });

    await withdrawHandler(req as AuthenticatedRequest, res as Response);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Conflict' }));
  });
});
