import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { createRateLimiter, rateLimitHandler } from '../src/middleware/rate-limiter.middleware.js';

describe('Rate Limiter Middleware', () => {
  it('should allow requests within the limit', async () => {
    const app = express();
    const limiter = rateLimit({
      windowMs: 1000,
      max: 2,
      message: { message: 'Too many requests' }
    });
    app.use(limiter);
    app.get('/test', (req, res) => res.status(200).json({ ok: true }));

    const res1 = await request(app).get('/test');
    expect(res1.status).toBe(200);

    const res2 = await request(app).get('/test');
    expect(res2.status).toBe(200);
  });

  it('should block requests exceeding the limit', async () => {
    const app = express();
    const limiter = rateLimit({
      windowMs: 60000,
      max: 2,
      message: { message: 'Too many requests' }
    });
    app.use(limiter);
    app.get('/test', (req, res) => res.status(200).json({ ok: true }));

    await request(app).get('/test');
    await request(app).get('/test');
    
    const res3 = await request(app).get('/test');
    expect(res3.status).toBe(429);
    expect(res3.body.message).toBe('Too many requests');
  });

  it('isolates request buckets by the trusted forwarded client IP', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use(createRateLimiter({
      windowMs: 60_000,
      max: 1,
      message: 'Too many requests, please try again later.',
      handler: rateLimitHandler,
    }));
    app.get('/test', (_req, res) => res.status(200).json({ ok: true }));

    const firstIp = '198.51.100.10';
    const secondIp = '198.51.100.11';
    const first = await request(app).get('/test').set('X-Forwarded-For', firstIp);
    const repeated = await request(app).get('/test').set('X-Forwarded-For', firstIp);
    const isolated = await request(app).get('/test').set('X-Forwarded-For', secondIp);

    expect(first.status).toBe(200);
    expect(repeated.status).toBe(429);
    expect(repeated.body).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests, please try again later.',
      },
    });
    expect(isolated.status).toBe(200);
  });
});
