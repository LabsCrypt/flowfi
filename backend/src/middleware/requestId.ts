import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import logger, { requestContext } from '../logger.js';

// Accepts alphanumeric characters, dots, underscores, and hyphens, capped at
// 64 characters. This prevents log injection via newlines or other control
// characters in a client-supplied X-Request-ID header, since the value is
// echoed back in responses and written into every log line for the request.
const SAFE_REQUEST_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

function isValidRequestId(value: string): boolean {
  return SAFE_REQUEST_ID_PATTERN.test(value);
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['x-request-id'];
  const requestId = typeof header === 'string' && isValidRequestId(header) ? header : randomUUID();

  res.setHeader('X-Request-ID', requestId);

  const startMs = Date.now();

  res.on('finish', () => {
    logger.info('response sent', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startMs,
      requestId,
    });
  });

  requestContext.run({ requestId }, () => {
    logger.info('request received', { method: req.method, path: req.path, requestId });
    next();
  });
}
