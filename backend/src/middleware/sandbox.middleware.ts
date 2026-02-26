import type { Request, Response, NextFunction } from 'express';
import { getSandboxConfig, isSandboxModeEnabled } from '../config/sandbox.js';

/**
 * Extended Request interface with sandbox flag
 */
export interface SandboxRequest extends Request {
  sandbox?: boolean;
  sandboxMode?: boolean;
}

/**
 * Middleware to detect and enable sandbox mode
 * 
 * Sandbox mode can be activated via:
 * 1. Header: X-Sandbox-Mode: true
 * 2. Query parameter: ?sandbox=true
 * 
 * Sandbox mode must be globally enabled via SANDBOX_MODE_ENABLED=true
 */
export function sandboxMiddleware(
  req: SandboxRequest,
  res: Response,
  next: NextFunction
): void {
  const config = getSandboxConfig();
  
  // If sandbox mode is not globally enabled, skip
  if (!config.enabled) {
    req.sandbox = false;
    req.sandboxMode = false;
    return next();
  }

  let isSandbox = false;

  // Check header
  if (config.allowHeader) {
    const headerValue = req.headers[config.headerName.toLowerCase()];
    if (headerValue === 'true' || headerValue === '1') {
      isSandbox = true;
    }
  }

  // Check query parameter
  if (!isSandbox && config.allowQueryParam) {
    const queryValue = req.query[config.queryParamName];
    if (queryValue === 'true' || queryValue === '1') {
      isSandbox = true;
    }
  }

  req.sandbox = isSandbox;
  req.sandboxMode = isSandbox;

  // Add sandbox indicator to response headers
  if (isSandbox) {
    res.setHeader('X-Sandbox-Mode', 'true');
    res.setHeader('X-Environment', 'sandbox');
  } else {
    res.setHeader('X-Environment', 'production');
  }

  next();
}

/**
 * Helper to check if request is in sandbox mode
 */
export function isSandboxRequest(req: SandboxRequest): boolean {
  return req.sandbox === true;
}

/**
 * Middleware to require sandbox mode (returns 400 if not in sandbox)
 */
export function requireSandbox(
  req: SandboxRequest,
  res: Response,
  next: NextFunction
): void {
  if (!isSandboxModeEnabled()) {
    res.status(503).json({
      error: 'Sandbox mode not available',
      message: 'Sandbox mode is not enabled on this server.',
    });
    return;
  }

  if (!isSandboxRequest(req)) {
    res.status(400).json({
      error: 'Sandbox mode required',
      message: 'This endpoint requires sandbox mode. Add X-Sandbox-Mode: true header or ?sandbox=true query parameter.',
      hint: {
        header: 'X-Sandbox-Mode: true',
        queryParam: '?sandbox=true',
      },
    });
    return;
  }

  next();
}
