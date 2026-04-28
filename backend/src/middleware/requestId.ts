import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import logger, { requestContext } from '../logger.js';

const MAX_REQUEST_ID_LENGTH = 128;

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['x-request-id'];
  const requestId =
    typeof header === 'string' && header.length > 0 && header.length <= MAX_REQUEST_ID_LENGTH
      ? header
      : randomUUID();

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
