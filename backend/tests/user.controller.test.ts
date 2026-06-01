import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerUser, getUser, getUserEvents, getCurrentUser } from '../src/controllers/user.controller.js';
import { prisma } from '../src/lib/prisma.js';
import type { Request, Response } from 'express';

vi.mock('../src/lib/prisma.js', () => ({
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
    it('should return 404 if user not found', async () => {
      req.params = { publicKey: 'GNOTFOUND' };
      (prisma.user.findUnique as any).mockResolvedValue(null);

      await getUser(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should return user if found', async () => {
      req.params = { publicKey: 'GUSER1' };
      const mockUser = { publicKey: 'GUSER1', sentStreams: [], receivedStreams: [] };
      (prisma.user.findUnique as any).mockResolvedValue(mockUser);

      await getUser(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(mockUser);
    });
  });

  describe('getUserEvents', () => {
    it('should return 400 if publicKey is missing', async () => {
      req.params = {};
      await getUserEvents(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid publicKey parameter' });
    });

    it('should return 400 if publicKey is malformed', async () => {
      req.params = { publicKey: 'invalid-key' };
      await getUserEvents(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid Stellar public key format' });
    });

    it('should return 400 if publicKey has wrong format (too short)', async () => {
      req.params = { publicKey: 'GTOOSHORT' };
      await getUserEvents(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid Stellar public key format' });
    });

    it('should return paginated events', async () => {
      req.params = { publicKey: 'GD2XP6FNWL6IWULVMPNA2RV2T7GLCJHK3RH75GBCY7TSVIWDITJN4FXJ' };
      req.query = { limit: '10', offset: '0' };
      (prisma.streamEvent.findMany as any).mockResolvedValue([]);
      (prisma.streamEvent.count as any).mockResolvedValue(0);

      await getUserEvents(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: [],
        total: 0,
        limit: 10,
        offset: 0
      }));
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
});
