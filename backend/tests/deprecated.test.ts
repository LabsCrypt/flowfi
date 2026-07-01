import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';

// This file tests deprecated endpoints WITHOUT any Prisma mocking
// so the real route handlers respond directly without interference.

describe('Removed unversioned routes', () => {
    it('POST /streams returns 404 Not Found', async () => {
        const response = await request(app)
            .post('/streams')
            .send({})
            .set('Accept', 'application/json');

        expect(response.status).toBe(404);
    });

    it('POST /events returns 404 Not Found', async () => {
        const response = await request(app)
            .post('/events')
            .send({})
            .set('Accept', 'application/json');

        expect(response.status).toBe(404);
    });
});
