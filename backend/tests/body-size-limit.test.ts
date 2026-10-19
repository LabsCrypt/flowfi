import { describe, it, expect } from 'vitest';
import request from 'supertest';

import app from '../src/app.js';

/** Make a JSON body whose serialized size is at least `bytes`. */
function jsonBody(bytes: number): { blob: string } {
  return { blob: 'a'.repeat(bytes) };
}

describe('JSON body size limits', () => {
  it('rejects a standard-route payload larger than 100kb with a 413 JSON error', async () => {
    const res = await request(app)
      .post('/v1/auth/challenge')
      .set('Content-Type', 'application/json')
      .send(jsonBody(150 * 1024));

    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(typeof res.body.error.message).toBe('string');
  });

  it('accepts a standard-route payload under 100kb', async () => {
    const res = await request(app)
      .post('/v1/auth/challenge')
      .set('Content-Type', 'application/json')
      .send({ address: 'GABC' });

    // The route validates the body and returns its own error, but crucially the
    // parser did not reject it with a 413.
    expect(res.status).not.toBe(413);
  });

  it('allows a bulk route to carry up to 1mb', async () => {
    const res = await request(app)
      .post('/v1/streams/simulate')
      .set('Content-Type', 'application/json')
      .send(jsonBody(500 * 1024));

    expect(res.status).not.toBe(413);
  });

  it('still rejects a bulk route payload beyond 1mb', async () => {
    const res = await request(app)
      .post('/v1/streams/simulate')
      .set('Content-Type', 'application/json')
      .send(jsonBody(1200 * 1024));

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('does not tighten the limit for batch-creation paths', async () => {
    const res = await request(app)
      .post('/v1/streams/batch')
      .set('Content-Type', 'application/json')
      .send(jsonBody(300 * 1024));

    expect(res.status).not.toBe(413);
  });
});
