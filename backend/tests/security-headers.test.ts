import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';

describe('Global Security Headers Middleware', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
    });

    it('asserts normal response carries security headers', async () => {
        const response = await request(app).get('/');

        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['x-frame-options']).toBe('DENY');
        expect(response.headers['referrer-policy']).toBe('no-referrer');
        expect(response.headers['content-security-policy']).toBe(
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'"
        );
        expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
        expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
        expect(response.headers['x-powered-by']).toBeUndefined();
    });

    it('asserts Strict-Transport-Security is present only in production', async () => {
        // Test in non-production
        process.env.NODE_ENV = 'development';
        let response = await request(app).get('/');
        expect(response.headers['strict-transport-security']).toBeUndefined();

        // Test in production
        process.env.NODE_ENV = 'production';
        response = await request(app).get('/');
        expect(response.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    });

    it('asserts Swagger UI page serves with security headers and CSP', async () => {
        const response = await request(app).get('/api-docs/');
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.headers['content-security-policy']).toBe(
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'"
        );
    });
});
