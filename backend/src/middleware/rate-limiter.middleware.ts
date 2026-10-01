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
