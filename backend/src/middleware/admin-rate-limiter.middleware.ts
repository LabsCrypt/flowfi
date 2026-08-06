import { rateLimit } from 'express-rate-limit';
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
    // Use x-forwarded-for or remote address as key
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0]?.trim() ?? 'unknown';
    }
    return req.ip ?? 'unknown';
  },
  skip: (req: Request): boolean => {
    // Skip rate limiting in test environment
    return process.env.NODE_ENV === 'test';
  },
  handler: (req: Request, res: Response, _next, options): void => {
    res.status(options.statusCode).json(options.message);
  },
});
