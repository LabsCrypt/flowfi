import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createStream, listStreams, getStream, getStreamClaimableAmount, pauseStream, resumeStream } from '../src/controllers/stream.controller.js';
import { prisma } from '../src/lib/prisma.js';
import { claimableAmountService } from '../src/services/claimable.service.js';
import * as sorobanService from '../src/services/sorobanService.js';
import type { Request, Response } from 'express';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    stream: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
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
  isStale: vi.fn(),
  getStreamFromChain: vi.fn(),
  pauseStream: vi.fn(),
  resumeStream: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('Stream Controller', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;

  beforeEach(() => {
    vi.clearAllMocks();
    (sorobanService.isStale as any).mockReturnValue(false);
    (sorobanService.getStreamFromChain as any).mockResolvedValue(null);
    req = {
      body: {
        streamId: '123',
        sender: 'GSENDER',
        recipient: 'GRECIPIENT',
        tokenAddress: 'T1',
        ratePerSecond: '10',
        depositedAmount: '1000',
        startTime: '1622505600',
      },
      query: {},
      params: {},
    };
    // Authenticated caller matches body.sender by default (Issue #809).
    (req as any).user = { publicKey: 'GSENDER' };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
  });

  describe('createStream', () => {
    it('should create a stream successfully', async () => {
      (prisma.stream.findUnique as any).mockResolvedValue(null);
      (prisma.stream.upsert as any).mockResolvedValue({ streamId: 123 });

      await createStream(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(prisma.stream.upsert).toHaveBeenCalled();
    });

    it('should return 401 when the request is unauthenticated', async () => {
      (req as any).user = undefined;

      await createStream(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(prisma.stream.upsert).not.toHaveBeenCalled();
    });

    it('should return 403 when the caller is not the body sender (Issue #809)', async () => {
      (req as any).user = { publicKey: 'GATTACKER' };

      await createStream(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(prisma.stream.upsert).not.toHaveBeenCalled();
    });

    it('should reject 400 when sender is missing (Issue #809)', async () => {
      delete req.body.sender;
      (req as any).user = { publicKey: 'GSENDER' };

      await createStream(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(prisma.stream.upsert).not.toHaveBeenCalled();
    });

    it('should return 403 and not reactivate a cancelled stream owned by another wallet (Issue #809)', async () => {
      // A victim previously created (and cancelled) this stream.
      (prisma.stream.findUnique as any).mockResolvedValue({
        streamId: 123,
        sender: 'GVICTIM',
        isActive: false,
      });
      // Attacker authenticates as themselves and sets sender to their own key,
      // trying to hijack the victim's streamId.
      req.body.sender = 'GATTACKER';
      (req as any).user = { publicKey: 'GATTACKER' };

      await createStream(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(prisma.stream.upsert).not.toHaveBeenCalled();
    });

    it('should return 400 for invalid streamId', async () => {
      req.body.streamId = 'abc';
      await createStream(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 400 for non-positive ratePerSecond', async () => {
      req.body.ratePerSecond = '0';
      await createStream(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('listStreams', () => {
    it('should list streams with pagination', async () => {
      req.query = { address: 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ', limit: '10', offset: '0' };
      (prisma.stream.findMany as any).mockResolvedValue([]);
      (prisma.stream.count as any).mockResolvedValue(0);

      await listStreams(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ total: 0 }));
    });
  });

  describe('getStream', () => {
    it('should return 404 if stream not found', async () => {
      req.params = { streamId: '999' };
      (prisma.stream.findUnique as any).mockResolvedValue(null);

      await getStream(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should return stream if found', async () => {
      req.params = { streamId: '123' };
      (prisma.stream.findUnique as any).mockResolvedValue({ streamId: 123, updatedAt: new Date() });

      await getStream(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ streamId: 123 }));
    });
  });

  describe('getStreamClaimableAmount', () => {
    it('should return claimable amount', async () => {
      req.params = { streamId: '123' };
      (prisma.stream.findUnique as any).mockResolvedValue({ streamId: 123, updatedAt: new Date() });
      (claimableAmountService.getClaimableAmount as any).mockReturnValue({ claimableAmount: '100' });

      await getStreamClaimableAmount(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ claimableAmount: '100' }));
    });
  });

  describe('pauseStream', () => {
    it('should pause stream', async () => {
      req.params = { streamId: '123' };
      req.body = { secret: 'S123' };
      (req as any).user = { publicKey: 'GUSER1' };
      (prisma.stream.findUnique as any).mockResolvedValue({ streamId: 123, sender: 'GUSER1', isPaused: false, isActive: true });
      (sorobanService.pauseStream as any).mockResolvedValue({ txHash: 'tx123' });
      (prisma.stream.update as any).mockResolvedValue({ streamId: 123, isPaused: true });

      await pauseStream(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('resumeStream', () => {
    it('should resume stream', async () => {
      req.params = { streamId: '123' };
      req.body = { secret: 'S123' };
      (req as any).user = { publicKey: 'GUSER1' };
      (prisma.stream.findUnique as any).mockResolvedValue({ streamId: 123, sender: 'GUSER1', isPaused: true, isActive: true, pausedAt: Math.floor(Date.now() / 1000) });
      (sorobanService.resumeStream as any).mockResolvedValue({ txHash: 'tx123' });
      (prisma.stream.update as any).mockResolvedValue({ streamId: 123, isPaused: false });

      await resumeStream(req as Request, res as Response);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
