import { rateLimit, type Options } from 'express-rate-limit';
import type { NextFunction, Request, Response } from 'express';
import { getRequestId } from '../lib/request-context.js';

/**
 * Shared factory to create an express-rate-limit instance with common configuration.
 * 
 * @param options Configuration options for express-rate-limit
 * @returns Express rate limit middleware
 */
export function createRateLimiter(options: Partial<Options>) {
  return rateLimit({
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    ...options,
  });
}

/**
 * Default 429 handler: keeps the configured JSON message and stamps the
 * request id (Issue #1494), so throttled responses stay traceable in the logs
 * even though they never reach a route handler or the global error handler.
 */
export function rateLimitHandler(
  _req: Request,
  res: Response,
  _next: NextFunction,
  options: Options,
): void {
  const message = options.message;
  const body: Record<string, unknown> =
    typeof message === 'object' && message !== null
      ? { ...(message as Record<string, unknown>) }
      : { message };
  const requestId = getRequestId();
  if (requestId) body.requestId = requestId;
  res.status(options.statusCode).json(body);
}

export const globalRateLimiter = createRateLimiter({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 requests per `window` (here, per minute)
  standardHeaders: true,
  legacyHeaders: false,
  // The Prometheus scrape endpoint must never be throttled: a 429 would make
  // Prometheus mark the target down and blind the whole alerting pipeline.
  // It is protected by its own network/token guard instead.
  skip: (req) => req.path === '/metrics' || req.path.startsWith('/metrics/'),
  message: {
    message: 'Too many requests, please try again later.',
    status: 429,
  },
  handler: rateLimitHandler,
});
/**
 * Dedicated limiter for `/health` (issue #1511).
 *
 * Liveness probes hit this endpoint at a fixed cadence and must always pass —
 * but unbounded external scanners can flood it and saturate the DB pool with
 * the `SELECT 1` the handler runs on every request. 60 requests per minute per
 * IP is comfortably above any realistic probe, but low enough to stop a
 * scraper from amplifying a single connection into hundreds of DB hits/second.
 */
export const healthRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: {
    message: 'Too many health check requests, please try again later.',
    status: 429,
  },
});
