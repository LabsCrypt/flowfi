import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiVersionMiddleware, getApiVersion, DEFAULT_VERSION } from '../src/middleware/api-version.middleware.js';
import type { Response, NextFunction } from 'express';
import type { VersionedRequest } from '../src/middleware/api-version.middleware.js';

describe('API Version Middleware', () => {
  let req: Partial<VersionedRequest>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    next = vi.fn();
  });

  it('should extract v1 from path and rewrite url', () => {
    req = { path: '/v1/streams', url: '/v1/streams' };
    apiVersionMiddleware(req as VersionedRequest, res as Response, next);
    expect(req.apiVersion).toBe('v1');
    expect(req.url).toBe('/streams');
    expect(next).toHaveBeenCalled();
  });

  it('should return 400 for unsupported version', () => {
    req = { path: '/v2/streams', url: '/v2/streams' };
    apiVersionMiddleware(req as VersionedRequest, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('should skip version extraction if path does not match vN pattern', () => {
    req = { path: '/health', url: '/health' };
    apiVersionMiddleware(req as VersionedRequest, res as Response, next);
    expect(req.apiVersion).toBeUndefined();
    expect(req.url).toBe('/health');
    expect(next).toHaveBeenCalled();
  });

  it('should preserve query strings when rewriting url', () => {
    req = { path: '/v1/streams', url: '/v1/streams?sender=G123' };
    apiVersionMiddleware(req as VersionedRequest, res as Response, next);
    expect(req.url).toBe('/streams?sender=G123');
    expect(next).toHaveBeenCalled();
  });

  it('should return default version if apiVersion is missing', () => {
    req = {};
    expect(getApiVersion(req as VersionedRequest)).toBe(DEFAULT_VERSION);
  });
});
