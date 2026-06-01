import { describe, it, expect, vi, beforeEach } from 'vitest';
import { subscribe } from '../src/controllers/sse.controller.js';
import { sseService } from '../src/services/sse.service.js';
import { prisma } from '../src/lib/prisma.js';
import type { Request, Response } from 'express';

vi.mock('../src/services/sse.service.js', () => ({
  sseService: {
    isShuttingDown: vi.fn(),
    checkCapacity: vi.fn(),
    addClient: vi.fn(),
  },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    stream: {
      findMany: vi.fn(),
    },
  },
}));

describe('SSE Controller', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;

  beforeEach(() => {
    vi.clearAllMocks();
    req = {
      headers: {},
      query: {},
      ip: '127.0.0.1',
    };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      writeHead: vi.fn().mockReturnThis(),
      write: vi.fn().mockReturnThis(),
      setHeader: vi.fn().mockReturnThis(),
      on: vi.fn(),
    };
  });

  it('should return 503 if shutting down', async () => {
    (sseService.isShuttingDown as any).mockReturnValue(true);

    await subscribe(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('should return 503 if over capacity', async () => {
    (sseService.isShuttingDown as any).mockReturnValue(false);
    (sseService.checkCapacity as any).mockReturnValue({ allowed: false, status: 503, message: 'Too many connections' });

    await subscribe(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Too many connections' }));
  });

  it('should subscribe and add client to sseService', async () => {
    (sseService.isShuttingDown as any).mockReturnValue(false);
    (sseService.checkCapacity as any).mockReturnValue({ allowed: true });
    (req as any).user = { publicKey: 'GUSER1' };
    (prisma.stream.findMany as any).mockResolvedValue([{ streamId: 1 }]);
    
    await subscribe(req as Request, res as Response);

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(sseService.addClient).toHaveBeenCalled();
  });

  it('should include user subscriptions when users query params are provided', async () => {
    (sseService.isShuttingDown as any).mockReturnValue(false);
    (sseService.checkCapacity as any).mockReturnValue({ allowed: true });
    (req as any).user = { publicKey: 'GUSER1' };
    (prisma.stream.findMany as any).mockResolvedValue([{ streamId: 'stream-1' }]);
    req.query = { users: ['GUSER2', 'GUSER3'] };

    await subscribe(req as Request, res as Response);

    expect(sseService.addClient).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.arrayContaining(['stream-1', 'user:GUSER2', 'user:GUSER3', 'user:GUSER1']),
      expect.any(String),
    );
  });

  it('should handle zod validation error for query params', async () => {
    (sseService.isShuttingDown as any).mockReturnValue(false);
    (sseService.checkCapacity as any).mockReturnValue({ allowed: true });
    (req as any).user = { publicKey: 'GUSER1' };
    req.query = { streams: 'not-an-array' };

    await subscribe(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});
