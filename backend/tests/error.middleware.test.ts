import { describe, it, expect, vi, beforeEach } from 'vitest';
import { errorHandler } from '../src/middleware/error.middleware.js';
import { ZodError } from 'zod';
import { Prisma } from '../src/generated/prisma/index.js';
import type { Request, Response, NextFunction } from 'express';

describe('Error Middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    req = {};
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    next = vi.fn();
  });

  it('should handle ZodError', () => {
    const error = new ZodError([{ path: ['field'], message: 'invalid', code: 'custom' }]);
    errorHandler(error, req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Validation Error' }));
  });

  it('should handle Prisma P2002 error', () => {
    const error = new Prisma.PrismaClientKnownRequestError('Conflict', { code: 'P2002', clientVersion: '1.0', meta: { target: ['email'] } });
    errorHandler(error, req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Conflict Error' }));
  });

  it('should handle Prisma P2025 error', () => {
    const error = new Prisma.PrismaClientKnownRequestError('Not found', { code: 'P2025', clientVersion: '1.0' });
    errorHandler(error, req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('should handle generic error', () => {
    const error = new Error('Generic error');
    errorHandler(error, req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
