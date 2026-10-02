import { describe, it, expect } from 'vitest';
import request from 'supertest';

import app from '../src/app.js';

/**
 * Mounted-route coverage: proves the tokens router is wired into the versioned
 * API surface (not just unit-mounted in isolation), including the version
 * rewrite performed by `apiVersionMiddleware`.
 */
describe('GET /v1/tokens (versioned mount)', () => {
  it('serves token metadata with caching headers', async () => {
    const res = await request(app).get('/v1/tokens');

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('public');
    expect(res.headers['cache-control']).toContain('max-age=3600');
    expect(res.headers['etag']).toBeDefined();
    expect(Array.isArray(res.body.tokens)).toBe(true);
    expect(res.body.tokens.length).toBeGreaterThan(0);
  });

  it('returns 304 Not Modified for a matching If-None-Match', async () => {
    const first = await request(app).get('/v1/tokens');
    expect(first.status).toBe(200);

    const second = await request(app)
      .get('/v1/tokens')
      .set('If-None-Match', String(first.headers['etag']));

    expect(second.status).toBe(304);
  });
});
