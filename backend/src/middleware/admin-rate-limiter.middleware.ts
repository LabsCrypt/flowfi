import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response } from 'express';

export const adminRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // Stricter limit: 30 requests per minute for admin endpoints
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many admin requests',
    message: 'You have exceeded the admin rate limit. Please try again later.',
    status: 429,
  },
  keyGenerator: (req: Request): string => {
    // Use x-forwarded-for or remote address as key. ipKeyGenerator normalizes
    // IPv6 addresses to a subnet (required by express-rate-limit v8).
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      typeof forwarded === 'string'
        ? (forwarded.split(',')[0]?.trim() ?? req.ip)
        : req.ip;
    return ipKeyGenerator(ip ?? 'unknown');
  },
  skip: (req: Request): boolean => {
    // Skip rate limiting in test environment
    return process.env.NODE_ENV === 'test';
  },
  handler: (req: Request, res: Response, _next, options): void => {
    res.status(options.statusCode).json(options.message);
  },
});
