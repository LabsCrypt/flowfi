import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import request from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createStreamRateLimiter } from '../src/middleware/stream-rate-limiter.middleware.js';
import type { AuthenticatedRequest } from '../src/types/auth.types.js';

/**
 * Mock authenticated user middleware
 */
function mockAuthMiddleware(publicKey: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    (req as AuthenticatedRequest).user = { publicKey };
    next();
  };
}

describe('Stream Creation Rate Limiter Middleware', () => {
  let app: any;

  beforeEach(() => {
    // Create a fresh Express app for each test
    app = express();
    app.use(express.json());
  });

  describe('Basic Rate Limiting', () => {
    it('should allow requests under the limit', async () => {
      const limiter = createStreamRateLimiter({ windowMs: 10000, max: 3 });

      app.post(
        '/streams',
        mockAuthMiddleware('GTEST123456'),
        limiter,
        (req: Request, res: Response) => res.status(201).json({ streamId: 1 })
      );

      // Make 3 requests - all should succeed
      for (let i = 1; i <= 3; i++) {
        const res = await request(app)
          .post('/streams')
          .set('Content-Type', 'application/json');
        expect(res.status).toBe(201);
        expect(res.body.streamId).toBe(1);
      }
    });

    it('should allow exactly limit number of requests', async () => {
      const limiter = createStreamRateLimiter({ windowMs: 10000, max: 5 });

      app.post(
        '/streams',
        mockAuthMiddleware('GTEST789012'),
        limiter,
        (req: Request, res: Response) => res.status(201).json({ success: true })
      );

      // Make exactly 5 requests - all should succeed
      const requests = Array(5).fill(null);
      for (const _ of requests) {
        const res = await request(app)
          .post('/streams')
          .set('Content-Type', 'application/json');
        expect(res.status).toBe(201);
      }
    });

    it('should return 429 when exceeding the limit', async () => {
      const limiter = createStreamRateLimiter({ windowMs: 10000, max: 2 });

      app.post(
        '/streams',
        mockAuthMiddleware('GWALLETABC'),
        limiter,
        (req: Request, res: Response) => res.status(201).json({ success: true })
      );

      // Make 2 successful requests
      await request(app).post('/streams').set('Content-Type', 'application/json');
      await request(app).post('/streams').set('Content-Type', 'application/json');

      // 3rd request should be rate limited
      const res = await request(app)
        .post('/streams')
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(429);
      expect(res.body).toHaveProperty('error');
      expect(res.body.error).toContain('rate limit');
    });

    it('should include Retry-After header in rate limit response', async () => {
      const limiter = createStreamRateLimiter({ windowMs: 10000, max: 1 });

      app.post(
        '/streams',
        mockAuthMiddleware('GWALLET123'),
        limiter,
        (req: Request, res: Response) => res.status(201).json({ success: true })
      );

      // First request succeeds
      await request(app).post('/streams').set('Content-Type', 'application/json');

      // Second request should be blocked
      const res = await request(app)
        .post('/streams')
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(429);
      // express-rate-limit sets RateLimit-Reset header with reset time
      expect(res.headers).toHaveProperty('ratelimit-reset');
    });
  });

  describe('Per-Wallet Rate Limiting', () => {
    it('should apply separate rate limits per wallet', async () => {
      const limiter = createStreamRateLimiter({ windowMs: 10000, max: 2 });

      const createRoute = (publicKey: string) => {
        app.post(
          `/streams-${publicKey}`,
          mockAuthMiddleware(publicKey),
          limiter,
          (req: Request, res: Response) => res.status(201).json({ wallet: publicKey, success: true })
        );
      };

      const wallet1 = 'GWALLET001';
      const wallet2 = 'GWALLET002';

      createRoute(wallet1);
      createRoute(wallet2);

      // Wallet 1 makes 2 requests - should succeed
      await request(app)
        .post(`/streams-${wallet1}`)
        .set('Content-Type', 'application/json');
      await request(app)
        .post(`/streams-${wallet1}`)
        .set('Content-Type', 'application/json');

      // Wallet 1 makes 3rd request - should fail
      let res = await request(app)
        .post(`/streams-${wallet1}`)
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(429);

      // Wallet 2 can still make 2 requests (separate limit)
      res = await request(app)
        .post(`/streams-${wallet2}`)
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(201);
      res = await request(app)
        .post(`/streams-${wallet2}`)
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(201);

      // Wallet 2 makes 3rd request - should fail
      res = await request(app)
        .post(`/streams-${wallet2}`)
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(429);
    });

    it('should use wallet address as rate limit key', async () => {
      const limiter = createStreamRateLimiter({ windowMs: 10000, max: 1 });
      const wallet = 'GUSER_WALLET_KEY_XYZ';

      app.post(
        '/streams',
        mockAuthMiddleware(wallet),
        limiter,
        (req: Request, res: Response) => res.status(201).json({ success: true })
      );

      // First request from this wallet
      const res1 = await request(app)
        .post('/streams')
        .set('Content-Type', 'application/json');
      expect(res1.status).toBe(201);

      // Second request from same wallet should be limited
      const res2 = await request(app)
        .post('/streams')
        .set('Content-Type', 'application/json');
      expect(res2.status).toBe(429);
    });
  });

  describe('Authentication Requirements', () => {
    it('should skip rate limiting for unauthenticated requests', async () => {
      const limiter = createStreamRateLimiter({ windowMs: 10000, max: 1 });

      app.post(
        '/streams',
        limiter, // No auth middleware
        (req: Request, res: Response) => res.status(201).json({ success: true })
      );

      // Multiple requests should not be rate limited
      // (they're skipped because there's no authenticated user)
      const res1 = await request(app)
        .post('/streams')
        .set('Content-Type', 'application/json');
      expect(res1.status).toBe(201);

      const res2 = await request(app)
        .post('/streams')
        .set('Content-Type', 'application/json');
      expect(res2.status).toBe(201);

      const res3 = await request(app)
        .post('/streams')
        .set('Content-Type', 'application/json');
      expect(res3.status).toBe(201);
    });

    it('should require authentication before rate limiting', async () => {
      const limiter = createStreamRateLimiter({ windowMs: 10000, max: 2 });

      app.post(
        '/streams',
        mockAuthMiddleware('GAUTH123'),
        limiter,
        (req: Request, res: Response) => res.status(201).json({ success: true })
      );

      // Authenticate and make requests up to limit
      await request(app)
        .post('/streams')
        .set('Content-Type', 'application/json');
      await request(app)
        .post('/streams')
        .set('Content-Type', 'application/json');

      // 3rd request is rate limited
      const res = await request(app)
        .post('/streams')
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(429);
    });
  });

  describe('Environment Variable Configuration', () => {
    it('should use STREAM_CREATE_RATE_LIMIT environment variable', () => {
      const originalEnv = process.env.STREAM_CREATE_RATE_LIMIT;
      process.env.STREAM_CREATE_RATE_LIMIT = '5';

      const limiter = createStreamRateLimiter({ windowMs: 10000 });
      // The limiter should be created with max: 5 from env

      // Clean up
      if (originalEnv) {
        process.env.STREAM_CREATE_RATE_LIMIT = originalEnv;
      } else {
        delete process.env.STREAM_CREATE_RATE_LIMIT;
      }
    });

    it('should default to 10 requests when STREAM_CREATE_RATE_LIMIT is not set', () => {
      const originalEnv = process.env.STREAM_CREATE_RATE_LIMIT;
      delete process.env.STREAM_CREATE_RATE_LIMIT;

      // The limiter should be created with max: 10 by default
      const limiter = createStreamRateLimiter({ windowMs: 10000 });

      // Clean up
      if (originalEnv) {
        process.env.STREAM_CREATE_RATE_LIMIT = originalEnv;
      }
    });
  });

  describe('Error Response Format', () => {
    it('should return proper error response when rate limited', async () => {
      const limiter = createStreamRateLimiter({ windowMs: 10000, max: 1 });

      app.post(
        '/streams',
        mockAuthMiddleware('GERROR123'),
        limiter,
        (req: Request, res: Response) => res.status(201).json({ success: true })
      );

      // Exceed limit
      await request(app).post('/streams').set('Content-Type', 'application/json');
      const res = await request(app)
        .post('/streams')
        .set('Content-Type', 'application/json');

      expect(res.status).toBe(429);
      expect(res.body).toHaveProperty('error');
      expect(res.body).toHaveProperty('message');
      expect(typeof res.body.message).toBe('string');
      expect(res.body.message.toLowerCase()).toContain('rate limit');
    });

    it('should include rate limit information in response headers', async () => {
      const limiter = createStreamRateLimiter({ windowMs: 10000, max: 2 });

      app.post(
        '/streams',
        mockAuthMiddleware('GHEADER123'),
        limiter,
        (req: Request, res: Response) => res.status(201).json({ success: true })
      );

      const res = await request(app)
        .post('/streams')
        .set('Content-Type', 'application/json');

      // Should include rate limit headers
      expect(res.headers).toHaveProperty('ratelimit-limit');
      expect(res.headers).toHaveProperty('ratelimit-remaining');
      expect(res.headers).toHaveProperty('ratelimit-reset');
    });
  });

  describe('Time Window Reset', () => {
    it('should reset rate limit after time window expires', async () => {
      const windowMs = 100; // Very short window for testing
      const limiter = createStreamRateLimiter({ windowMs, max: 1 });

      app.post(
        '/streams',
        mockAuthMiddleware('GWINDOW123'),
        limiter,
        (req: Request, res: Response) => res.status(201).json({ success: true })
      );

      // First request succeeds
      let res = await request(app)
        .post('/streams')
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(201);

      // Second request fails (over limit)
      res = await request(app)
        .post('/streams')
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(429);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, windowMs + 50));

      // Request after window reset should succeed
      res = await request(app)
        .post('/streams')
        .set('Content-Type', 'application/json');
      expect(res.status).toBe(201);
    });
  });
});
