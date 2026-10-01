import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { requestIdMiddleware } from '../src/middleware/requestId.js';
import { rateLimitHandler } from '../src/middleware/rate-limiter.middleware.js';
import { requestContext } from '../src/lib/request-context.js';
import app from '../src/app.js';
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

  it('should reject a header containing a newline and generate a safe id instead', () => {
    const malicious = 'abc123\nfake log line injected';
    req.headers = { 'x-request-id': malicious };
    requestIdMiddleware(req as Request, res as Response, next);
    const call = (res.setHeader as any).mock.calls[0];
    expect(call[1]).not.toBe(malicious);
    expect(call[1]).not.toMatch(/\n/);
    expect(call[1]).toMatch(/^[a-f0-9-]+$/i);
  });

  it('should reject a header with other control/special characters', () => {
    req.headers = { 'x-request-id': 'id\r\nSet-Cookie: evil=1' };
    requestIdMiddleware(req as Request, res as Response, next);
    const call = (res.setHeader as any).mock.calls[0];
    expect(call[1]).toMatch(/^[a-f0-9-]+$/i);
  });

  it('exposes the same id on the request object and the response header (Issue #1494)', () => {
    requestIdMiddleware(req as Request, res as Response, next);
    const headerValue = (res.setHeader as any).mock.calls[0][1];
    expect((req as Request & { id?: string }).id).toBe(headerValue);
  });
});

describe('X-Request-ID propagation (Issue #1494)', () => {
  it('sets the header on a normal response', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('echoes a valid client-supplied request id', async () => {
    const response = await request(app).get('/').set('X-Request-ID', 'client-trace-42');
    expect(response.headers['x-request-id']).toBe('client-trace-42');
  });

  it('includes requestId in an error payload produced by sendApiError', async () => {
    const response = await request(app)
      .get('/v1/streams/not-a-number')
      .set('X-Request-ID', 'err-trace-7');

    expect(response.status).toBe(400);
    expect(response.headers['x-request-id']).toBe('err-trace-7');
    expect(response.body.error.code).toBe('INVALID_STREAM_ID');
    expect(response.body.error.requestId).toBe('err-trace-7');
  });

  it('sets the header on a response short-circuited before the routers (CORS 403)', async () => {
    const response = await request(app)
      .get('/')
      .set('Origin', 'https://evil.example')
      .set('X-Request-ID', 'cors-trace-9');

    expect(response.status).toBe(403);
    expect(response.headers['x-request-id']).toBe('cors-trace-9');
    expect(response.body.requestId).toBe('cors-trace-9');
  });
});

describe('Rate limit 429 request id', () => {
  it('stamps requestId from the request context onto the throttle body', () => {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    const options = {
      statusCode: 429,
      message: { message: 'Too many requests' },
    } as any;

    requestContext.run({ requestId: 'rl-trace-1' }, () => {
      rateLimitHandler({} as Request, res as unknown as Response, vi.fn(), options);
    });

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({ message: 'Too many requests', requestId: 'rl-trace-1' });
  });
});
