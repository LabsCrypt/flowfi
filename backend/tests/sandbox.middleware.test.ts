import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Response } from 'express';
import * as sandboxConfig from '../src/config/sandbox.js';
import {
  requireSandbox,
  sandboxMiddleware,
  type SandboxRequest,
} from '../src/middleware/sandbox.middleware.js';

vi.mock('../src/config/sandbox.js', () => ({
  getSandboxConfig: vi.fn(),
  isSandboxModeEnabled: vi.fn(),
}));

type SandboxSettings = ReturnType<typeof sandboxConfig.getSandboxConfig>;

const defaultConfig = (overrides: Partial<SandboxSettings> = {}): SandboxSettings => ({
  enabled: true,
  allowHeader: true,
  allowQueryParam: true,
  headerName: 'X-Sandbox-Mode',
  queryParamName: 'sandbox',
  ...overrides,
});

describe('sandbox middleware', () => {
  let req: SandboxRequest;
  let res: Response;
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sandboxConfig.getSandboxConfig).mockReturnValue(defaultConfig());
    vi.mocked(sandboxConfig.isSandboxModeEnabled).mockReturnValue(true);

    req = { headers: {}, query: {} } as SandboxRequest;
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    } as unknown as Response;
    next = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('sandboxMiddleware', () => {
    it('sets both request flags false and calls next when sandbox mode is globally disabled', () => {
      vi.mocked(sandboxConfig.getSandboxConfig).mockReturnValue(
        defaultConfig({ enabled: false }),
      );
      req.headers = { 'x-sandbox-mode': 'true' };
      req.query = { sandbox: 'true' };

      sandboxMiddleware(req, res, next);

      expect(req.sandbox).toBe(false);
      expect(req.sandboxMode).toBe(false);
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledOnce();
    });

    it.each(['true', '1'])('enables sandbox for exact header value %s', (value) => {
      req.headers = { 'x-sandbox-mode': value };

      sandboxMiddleware(req, res, next);

      expect(req.sandbox).toBe(true);
      expect(req.sandboxMode).toBe(true);
      expect(res.setHeader).toHaveBeenCalledWith('X-Sandbox-Mode', 'true');
      expect(res.setHeader).toHaveBeenCalledWith('X-Environment', 'sandbox');
      expect(next).toHaveBeenCalledOnce();
    });

    it.each(['true', '1'])('enables sandbox for exact query value %s', (value) => {
      vi.mocked(sandboxConfig.getSandboxConfig).mockReturnValue(
        defaultConfig({ allowHeader: false }),
      );
      req.query = { sandbox: value };

      sandboxMiddleware(req, res, next);

      expect(req.sandbox).toBe(true);
      expect(req.sandboxMode).toBe(true);
      expect(res.setHeader).toHaveBeenCalledWith('X-Sandbox-Mode', 'true');
      expect(res.setHeader).toHaveBeenCalledWith('X-Environment', 'sandbox');
      expect(next).toHaveBeenCalledOnce();
    });

    it.each([
      ['uppercase header value', { 'x-sandbox-mode': 'TRUE' }, {}],
      ['truthy-looking header value', { 'x-sandbox-mode': 'yes' }, {}],
      ['empty header value', { 'x-sandbox-mode': '' }, {}],
      ['uppercase query value', {}, { sandbox: 'TRUE' }],
      ['truthy-looking query value', {}, { sandbox: 'yes' }],
      ['empty query value', {}, { sandbox: '' }],
      ['array header value', { 'x-sandbox-mode': ['true', '1'] }, {}],
      ['array query value', {}, { sandbox: ['true'] }],
    ])('does not enable sandbox for %s', (_description, headers, query) => {
      req.headers = headers;
      req.query = query;

      sandboxMiddleware(req, res, next);

      expect(req.sandbox).toBe(false);
      expect(req.sandboxMode).toBe(false);
      expect(res.setHeader).toHaveBeenCalledWith('X-Environment', 'production');
      expect(res.setHeader).not.toHaveBeenCalledWith('X-Sandbox-Mode', 'true');
      expect(next).toHaveBeenCalledOnce();
    });

    it('ignores the header when header activation is disabled and can still use the query', () => {
      vi.mocked(sandboxConfig.getSandboxConfig).mockReturnValue(
        defaultConfig({ allowHeader: false }),
      );
      req.headers = { 'x-sandbox-mode': 'true' };

      sandboxMiddleware(req, res, next);

      expect(req.sandbox).toBe(false);
      expect(res.setHeader).toHaveBeenCalledWith('X-Environment', 'production');

      vi.clearAllMocks();
      vi.mocked(sandboxConfig.getSandboxConfig).mockReturnValue(
        defaultConfig({ allowHeader: false }),
      );
      req.query = { sandbox: '1' };

      sandboxMiddleware(req, res, next);

      expect(req.sandbox).toBe(true);
      expect(res.setHeader).toHaveBeenCalledWith('X-Environment', 'sandbox');
    });

    it('ignores the query when query activation is disabled but still accepts the header', () => {
      vi.mocked(sandboxConfig.getSandboxConfig).mockReturnValue(
        defaultConfig({ allowQueryParam: false }),
      );
      req.query = { sandbox: 'true' };

      sandboxMiddleware(req, res, next);

      expect(req.sandbox).toBe(false);
      expect(res.setHeader).toHaveBeenCalledWith('X-Environment', 'production');

      vi.clearAllMocks();
      vi.mocked(sandboxConfig.getSandboxConfig).mockReturnValue(
        defaultConfig({ allowQueryParam: false }),
      );
      req.headers = { 'x-sandbox-mode': '1' };

      sandboxMiddleware(req, res, next);

      expect(req.sandbox).toBe(true);
      expect(res.setHeader).toHaveBeenCalledWith('X-Environment', 'sandbox');
    });

    it('uses configured header and query names', () => {
      vi.mocked(sandboxConfig.getSandboxConfig).mockReturnValue(
        defaultConfig({ headerName: 'X-Custom-Sandbox', queryParamName: 'testMode' }),
      );
      req.headers = { 'x-custom-sandbox': 'true' };

      sandboxMiddleware(req, res, next);

      expect(req.sandbox).toBe(true);

      vi.clearAllMocks();
      vi.mocked(sandboxConfig.getSandboxConfig).mockReturnValue(
        defaultConfig({ allowHeader: false, queryParamName: 'testMode' }),
      );
      req.query = { testMode: '1' };

      sandboxMiddleware(req, res, next);

      expect(req.sandbox).toBe(true);
    });

    it('does not inspect the query once the header has enabled sandbox', () => {
      req.headers = { 'x-sandbox-mode': 'true' };
      Object.defineProperty(req, 'query', {
        configurable: true,
        get: () => {
          throw new Error('query should not be read');
        },
      });

      expect(() => sandboxMiddleware(req, res, next)).not.toThrow();
      expect(req.sandbox).toBe(true);
      expect(next).toHaveBeenCalledOnce();
    });

    it('propagates a configuration failure without calling next', () => {
      const failure = new Error('invalid sandbox configuration');
      vi.mocked(sandboxConfig.getSandboxConfig).mockImplementation(() => {
        throw failure;
      });

      expect(() => sandboxMiddleware(req, res, next)).toThrow(failure);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('requireSandbox', () => {
    it('continues when sandbox mode is enabled and the request is sandboxed', () => {
      req.sandbox = true;

      requireSandbox(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    });

    it('returns the stable 400 error envelope and hint when the request is not sandboxed', () => {
      req.sandbox = false;

      requireSandbox(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'SANDBOX_MODE_REQUIRED',
          message:
            'This endpoint requires sandbox mode. Add X-Sandbox-Mode: true header or ?sandbox=true query parameter.',
          details: {
            hint: {
              header: 'X-Sandbox-Mode: true',
              queryParam: '?sandbox=true',
            },
          },
        },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns the stable 503 error envelope when sandbox mode is unavailable', () => {
      vi.mocked(sandboxConfig.isSandboxModeEnabled).mockReturnValue(false);
      req.sandbox = true;

      requireSandbox(req, res, next);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        error: {
          code: 'SANDBOX_MODE_NOT_AVAILABLE',
          message: 'Sandbox mode is not enabled on this server.',
        },
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('propagates an availability-check failure without calling next', () => {
      const failure = new Error('sandbox availability check failed');
      vi.mocked(sandboxConfig.isSandboxModeEnabled).mockImplementation(() => {
        throw failure;
      });

      expect(() => requireSandbox(req, res, next)).toThrow(failure);
      expect(next).not.toHaveBeenCalled();
    });
  });
});
