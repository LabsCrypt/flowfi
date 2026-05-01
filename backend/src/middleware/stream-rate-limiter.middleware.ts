import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { type Request, type Response, type NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/auth.types.js';
import logger from '../logger.js';

/**
 * Create a per-wallet rate limiter middleware for stream creation
 * Uses the authenticated wallet address as the rate limit key
 * 
 * @param options Configuration options
 * @param options.windowMs Time window in milliseconds (default: 1 minute)
 * @param options.max Maximum requests per window (default: 10, configurable via STREAM_CREATE_RATE_LIMIT)
 * @returns Express rate limit middleware
 */
export function createStreamRateLimiter(
  options?: {
    windowMs?: number;
    max?: number;
  }
) {
  const windowMs = options?.windowMs ?? 60 * 1000; // 1 minute
  // Read from environment variable, default to 10 if not set
  const max = options?.max ?? (process.env.STREAM_CREATE_RATE_LIMIT ? parseInt(process.env.STREAM_CREATE_RATE_LIMIT, 10) : 10);

  return rateLimit({
    windowMs,
    max,
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: {
      error: 'Too many stream creation requests - rate limit exceeded',
      message: 'You have exceeded the rate limit for stream creation. Please try again later.',
      status: 429,
    },
    /**
     * KeyGenerator: Use wallet address as the rate limit key
     * For authenticated requests, use the wallet's public key
     */
    keyGenerator: (req: Request, res: Response): string => {
      const authReq = req as AuthenticatedRequest;
      if (authReq.user?.publicKey) {
        return authReq.user.publicKey; // Use wallet address as key
      }
      // Fallback to IP if not authenticated (shouldn't happen for protected endpoints).
      // Use ipKeyGenerator so IPv6 addresses are normalized correctly.
      return req.ip ? ipKeyGenerator(req.ip) : 'unknown';
    },
    /**
     * Skip rate limiting for non-authenticated requests
     * to ensure we only rate limit authenticated users
     */
    skip: (req: Request, res: Response): boolean => {
      const authReq = req as AuthenticatedRequest;
      if (!authReq.user?.publicKey) {
        logger.warn('Stream creation rate limiter skipped: no authenticated user');
        return true;
      }
      return false;
    },
    handler: (req: Request, res: Response, next: NextFunction, options: any): void => {
      const authReq = req as AuthenticatedRequest;
      logger.warn(
        `Rate limit exceeded for wallet: ${authReq.user?.publicKey || 'unknown'}`,
        { endpoint: req.path, method: req.method }
      );
      res.status(options.statusCode).json(options.message);
    },
  });
}

/**
 * Pre-configured rate limiter for stream creation endpoint
 * 10 requests per minute per wallet
 */
export const streamCreationRateLimiter = createStreamRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute
});
