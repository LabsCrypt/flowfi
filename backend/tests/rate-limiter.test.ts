import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { rateLimit } from 'express-rate-limit';

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
});
