import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';

describe('CORS middleware', () => {
    it('returns 403 for non-whitelisted origin', async () => {
        const response = await request(app)
            .get('/')
            .set('Origin', 'https://evil.example')
            .set('Accept', 'text/plain');

        expect(response.status).toBe(403);
        expect(response.body.error).toBe('CORS origin not allowed');
    });
});
