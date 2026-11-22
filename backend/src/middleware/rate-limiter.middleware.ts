import type { NextFunction, Request, Response } from 'express';
import { rateLimit, type Options } from 'express-rate-limit';
import { sendApiError } from '../lib/api-error.js';

/**
 * Answers a throttled request in the shared error envelope (issue #1851).
 *
 * express-rate-limit's default handler sends its `message` option verbatim, so
 * leaving it unset would keep 429s in a `{ message, status }` shape no other
 * error response uses. `message` therefore stays a plain string here and this
 * handler supplies the code.
 */
export function rateLimitHandler(
  _req: Request,
  res: Response,
  _next: NextFunction,
  options: { statusCode?: number; message?: unknown },
): void {
  sendApiError(
    res,
    options.statusCode ?? 429,
    'RATE_LIMITED',
    typeof options.message === 'string'
      ? options.message
      : 'Too many requests, please try again later.',
  );
}

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

export const globalRateLimiter = createRateLimiter({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 requests per `window` (here, per minute)
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // The Prometheus scrape endpoint must never be throttled: a 429 would make
  // Prometheus mark the target down and blind the whole alerting pipeline.
  // It is protected by its own network/token guard instead.
  skip: (req) => req.path === '/metrics' || req.path.startsWith('/metrics/'),
  message: 'Too many requests, please try again later.',
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
  message: 'Too many health check requests, please try again later.',
  handler: rateLimitHandler,
});
