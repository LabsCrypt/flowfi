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
    // Prefer the left-most proxy hop; fall back to the subnet-scoped request
    // IP (ipKeyGenerator buckets IPv6 clients by /64 so a single user cannot
    // rotate addresses to bypass the limit — express-rate-limit's
    // ERR_ERL_KEY_GEN_IPV6 requirement).
    const forwarded = req.headers['x-forwarded-for'];
    const firstHop = typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined;
    if (firstHop) return firstHop;
    return req.ip ? ipKeyGenerator(req.ip) : 'unknown';
  },
  skip: (req: Request): boolean => {
    // Skip rate limiting in test environment
    return process.env.NODE_ENV === 'test';
  },
  handler: (req: Request, res: Response, _next, options): void => {
    res.status(options.statusCode).json(options.message);
  },
});
