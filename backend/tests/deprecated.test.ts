import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';

// This file tests deprecated endpoints WITHOUT any Prisma mocking
// so the real route handlers respond directly without interference.

describe('Deprecated route responses', () => {
    it('POST /streams returns 410 Gone', async () => {
        const response = await request(app)
            .post('/streams')
            .send({})
            .set('Accept', 'application/json');

        expect(response.status).toBe(410);
        expect(response.body.deprecated).toBe(true);
        expect(response.body.migration).toMatchObject({ old: '/streams', new: '/v1/streams' });
    });

    it('POST /events returns 410 Gone', async () => {
        const response = await request(app)
            .post('/events')
            .send({})
            .set('Accept', 'application/json');

        expect(response.status).toBe(410);
        expect(response.body.deprecated).toBe(true);
        expect(response.body.migration).toMatchObject({ old: '/events', new: '/v1/events' });
    });
});
