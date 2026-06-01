import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestIdMiddleware } from '../src/middleware/requestId.js';
import type { Request, Response, NextFunction } from 'express';

describe('RequestId Middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    req = {
      headers: {},
      method: 'GET',
      path: '/test',
    };
    res = {
      setHeader: vi.fn(),
      on: vi.fn(),
    };
    next = vi.fn();
  });

  it('should generate a new requestId if missing', () => {
    requestIdMiddleware(req as Request, res as Response, next);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', expect.any(String));
    expect(next).toHaveBeenCalled();
  });

  it('should use existing requestId from header', () => {
    req.headers = { 'x-request-id': 'existing-id' };
    requestIdMiddleware(req as Request, res as Response, next);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', 'existing-id');
    expect(next).toHaveBeenCalled();
  });

  it('should generate new id if header is too long', () => {
    req.headers = { 'x-request-id': 'a'.repeat(129) };
    requestIdMiddleware(req as Request, res as Response, next);
    const call = (res.setHeader as any).mock.calls[0];
    expect(call[1]).not.toBe('a'.repeat(129));
  });
});
