import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerUser, getUser, getUserEvents, getCurrentUser, exportTransactions } from '../src/controllers/user.controller.js';
import * as exportService from '../src/services/export.service.js';
import { prisma } from '../src/lib/prisma.js';
import type { Request, Response } from 'express';

vi.mock('../src/lib/prisma.js', () => ({
  withReplicaFallback: (query: (client: any) => unknown) => Promise.resolve(query(prisma)),
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    streamEvent: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('User Controller', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: any;

  beforeEach(() => {
    vi.clearAllMocks();
    req = {};
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    next = vi.fn();
  });

  describe('registerUser', () => {
    it('should register a new user', async () => {
      const publicKey = 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ';
      req.body = { publicKey };
      (prisma.user.findUnique as any).mockResolvedValue(null);
      (prisma.user.create as any).mockResolvedValue({ publicKey });

      await registerUser(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ publicKey });
    });

    it('should return 200 if user already exists', async () => {
      const publicKey = 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ';
      req.body = { publicKey };
      (prisma.user.findUnique as any).mockResolvedValue({ publicKey });

      await registerUser(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ publicKey });
    });

    it('should call next with error if prisma fails', async () => {
      const publicKey = 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ';
      req.body = { publicKey };
      (prisma.user.findUnique as any).mockRejectedValue(new Error('DB error'));

      await registerUser(req as Request, res as Response, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('getUser', () => {
    it('should return 400 if publicKey is missing', async () => {
      req.params = {};

      await getUser(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: { code: 'INVALID_PUBLIC_KEY', message: 'Invalid publicKey parameter' },
      });
    });

    it('should return 400 if publicKey is malformed', async () => {
      req.params = { publicKey: 'invalid-key' };

      await getUser(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: { code: 'INVALID_PUBLIC_KEY', message: 'Invalid Stellar public key format' },
      });
    });

    it('should return 404 if user not found', async () => {
      req.params = { publicKey: 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ' };
      (prisma.user.findUnique as any).mockResolvedValue(null);

      await getUser(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should return user if found', async () => {
      const publicKey = 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ';
      req.params = { publicKey };
      const mockUser = { publicKey, sentStreams: [], receivedStreams: [] };
      (prisma.user.findUnique as any).mockResolvedValue(mockUser);

      await getUser(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(mockUser);
    });

    it('should query with an explicit select clause excluding internal-only fields', async () => {
      const publicKey = 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ';
      req.params = { publicKey };
      const mockUser = { id: 'uuid-1', publicKey, createdAt: new Date(), updatedAt: new Date(), sentStreams: [], receivedStreams: [] };
      (prisma.user.findUnique as any).mockResolvedValue(mockUser);

      await getUser(req as Request, res as Response, next);

      const call = (prisma.user.findUnique as any).mock.calls[0][0];
      expect(call.select).toBeDefined();
      expect(call.include).toBeUndefined();

      const jsonArg = (res.json as any).mock.calls[0][0];
      expect(jsonArg).not.toHaveProperty('passwordHash');
      expect(jsonArg).not.toHaveProperty('internalNotes');
      expect(jsonArg).not.toHaveProperty('apiSecret');
    });
  });

  describe('getUserEvents', () => {
    // Issue #1533: the endpoint is authenticated and scoped to the caller.
    const VIEWER = 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ';

    beforeEach(() => {
      (req as any).user = { publicKey: VIEWER };
    });

    it('returns 401 when the request is unauthenticated (#1533)', async () => {
      req.params = { publicKey: VIEWER };
      delete (req as any).user;

      await getUserEvents(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(prisma.streamEvent.findMany).not.toHaveBeenCalled();
    });

    it('returns 403 when requesting another wallet\'s history (#1533)', async () => {
      req.params = { publicKey: 'GCNO64M4RVXL4QA43XCMQHA4S2MYUWLFEAYS6OQUXNA4EFC7XUMXBBEY' };

      await getUserEvents(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(prisma.streamEvent.findMany).not.toHaveBeenCalled();
    });

    it('should return 400 if publicKey is missing', async () => {
      req.params = {};
      await getUserEvents(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: { code: 'INVALID_PUBLIC_KEY', message: 'Invalid publicKey parameter' },
      });
    });

    it('should return 400 if publicKey is malformed', async () => {
      req.params = { publicKey: 'invalid-key' };
      await getUserEvents(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: { code: 'INVALID_PUBLIC_KEY', message: 'Invalid Stellar public key format' },
      });
    });

    it('should return 400 if publicKey has wrong format (too short)', async () => {
      req.params = { publicKey: 'GTOOSHORT' };
      await getUserEvents(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: { code: 'INVALID_PUBLIC_KEY', message: 'Invalid Stellar public key format' },
      });
    });

    it('should return paginated events', async () => {
      req.params = { publicKey: 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ' };
      req.query = { limit: '10', offset: '0' };
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      await getUserEvents(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(prisma.streamEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { timestamp: 'desc' },
        }),
      );
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: [],
        total: 0,
        limit: 10,
        offset: 0
      }));
    });

    it('includes the related stream by default', async () => {
      req.params = { publicKey: 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ' };
      req.query = {};
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      await getUserEvents(req as Request, res as Response, next);

      expect(prisma.streamEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ include: { stream: true } }),
      );
    });

    it('omits the related stream when includeStream=false', async () => {
      req.params = { publicKey: 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ' };
      req.query = { includeStream: 'false' };
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      await getUserEvents(req as Request, res as Response, next);

      const callArgs = (prisma.streamEvent.findMany as any).mock.calls[0][0];
      expect(callArgs.include).toBeUndefined();
    });

    it('forwards a comma-separated type filter to the shared query helper', async () => {
      req.params = { publicKey: 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ' };
      req.query = { type: 'PAUSED,RESUMED' };
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      await getUserEvents(req as Request, res as Response, next);

      const callArgs = (prisma.streamEvent.findMany as any).mock.calls[0][0];
      expect(callArgs.where.eventType).toEqual({ in: ['PAUSED', 'RESUMED'] });
    });

    it('returns 400 when the type filter has no valid values', async () => {
      req.params = { publicKey: 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ' };
      req.query = { type: 'BOGUS' };

      await getUserEvents(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(prisma.streamEvent.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getCurrentUser', () => {
    it('should return 200 with user from DB', async () => {
      (req as any).user = { publicKey: 'GME' };
      (prisma.user.findUnique as any).mockResolvedValue({ publicKey: 'GME' });

      await getCurrentUser(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ publicKey: 'GME' });
    });

    it('should return in-memory user if not in DB', async () => {
      (req as any).user = { publicKey: 'GME' };
      (prisma.user.findUnique as any).mockResolvedValue(null);

      await getCurrentUser(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        publicKey: 'GME',
        inMemory: true
      }));
    });
  });

  describe('exportTransactions date range validation', () => {
    const address = 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ';

    beforeEach(() => {
      vi.spyOn(exportService, 'streamTransactionCSV').mockResolvedValue();
      vi.spyOn(exportService, 'streamTransactionJSON').mockResolvedValue();
      req.params = { address };
    });

    it.each(['csv', 'json'])('allows omitted dates for %s exports', async (format) => {
      req.query = { format };
      await exportTransactions(req as Request, res as Response, next);
      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(format === 'csv' ? exportService.streamTransactionCSV : exportService.streamTransactionJSON)
        .toHaveBeenCalled();
    });

    it.each(['csv', 'json'])('rejects malformed and reversed ranges before starting %s exports', async (format) => {
      req.query = { format, startDate: 'not-a-date', endDate: '2026-01-01' };
      await exportTransactions(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(exportService.streamTransactionCSV).not.toHaveBeenCalled();
      expect(exportService.streamTransactionJSON).not.toHaveBeenCalled();

      vi.clearAllMocks();
      req.query = { format, startDate: '2026-02-01', endDate: '2026-01-01' };
      await exportTransactions(req as Request, res as Response, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(exportService.streamTransactionCSV).not.toHaveBeenCalled();
      expect(exportService.streamTransactionJSON).not.toHaveBeenCalled();
    });

    it.each(['csv', 'json'])('passes a valid inclusive date range to the %s exporter', async (format) => {
      req.query = { format, startDate: '2026-01-01', endDate: '2026-01-31' };
      await exportTransactions(req as Request, res as Response, next);
      const exporter = format === 'csv' ? exportService.streamTransactionCSV : exportService.streamTransactionJSON;
      expect(exporter).toHaveBeenCalledWith(address, expect.objectContaining({
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-01-31'),
      }), res);
    });
  });
});
