import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sandboxMiddleware, isSandboxRequest, requireSandbox } from '../src/middleware/sandbox.middleware.js';
import * as sandboxConfig from '../src/config/sandbox.js';
import type { Response, NextFunction } from 'express';
import type { SandboxRequest } from '../src/middleware/sandbox.middleware.js';

vi.mock('../src/config/sandbox.js', () => ({
  getSandboxConfig: vi.fn(),
  isSandboxModeEnabled: vi.fn(),
}));

describe('Sandbox Middleware', () => {
  let req: Partial<SandboxRequest>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    req = { headers: {}, query: {} };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn(),
    };
    next = vi.fn();
  });

  it('should skip if not enabled globally', () => {
    (sandboxConfig.getSandboxConfig as any).mockReturnValue({ enabled: false });
    sandboxMiddleware(req as SandboxRequest, res as Response, next);
    expect(req.sandbox).toBe(false);
    expect(next).toHaveBeenCalled();
  });

  it('should detect sandbox via header', () => {
    (sandboxConfig.getSandboxConfig as any).mockReturnValue({
      enabled: true,
      allowHeader: true,
      headerName: 'X-Sandbox-Mode',
    });
    req.headers = { 'x-sandbox-mode': 'true' };
    sandboxMiddleware(req as SandboxRequest, res as Response, next);
    expect(req.sandbox).toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith('X-Sandbox-Mode', 'true');
    expect(next).toHaveBeenCalled();
  });

  it('should detect sandbox via query param', () => {
    (sandboxConfig.getSandboxConfig as any).mockReturnValue({
      enabled: true,
      allowHeader: false,
      allowQueryParam: true,
      queryParamName: 'sandbox',
    });
    req.query = { sandbox: 'true' };
    sandboxMiddleware(req as SandboxRequest, res as Response, next);
    expect(req.sandbox).toBe(true);
    expect(next).toHaveBeenCalled();
  });

  it('should return 400 in requireSandbox if not sandbox request', () => {
    (sandboxConfig.isSandboxModeEnabled as any).mockReturnValue(true);
    req.sandbox = false;
    requireSandbox(req as SandboxRequest, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 503 in requireSandbox if globally disabled', () => {
    (sandboxConfig.isSandboxModeEnabled as any).mockReturnValue(false);
    requireSandbox(req as SandboxRequest, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
