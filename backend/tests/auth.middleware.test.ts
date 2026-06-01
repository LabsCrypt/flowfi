import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireAuth } from '../src/middleware/auth.js';
import type { Request, Response, NextFunction } from 'express';

describe('Auth Middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    req = { headers: {} };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    next = vi.fn();
  });

  it('should return 401 if no auth header', () => {
    requireAuth(req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should return 401 if auth header is not Bearer', () => {
    req.headers = { authorization: 'Basic 123' };
    requireAuth(req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
