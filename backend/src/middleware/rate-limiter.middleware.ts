import { rateLimit, type Options } from 'express-rate-limit';

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
  message: {
    message: 'Too many requests, please try again later.',
    status: 429,
  },
});
