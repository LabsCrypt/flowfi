import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Express } from 'express';
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

/**
 * The CORS policy is resolved when the app module is evaluated, so each case
 * resets the module registry and re-imports the app with a fresh environment.
 */
const ENV_KEYS = ['NODE_ENV', 'FRONTEND_URL', 'CORS_ALLOWED_ORIGINS', 'CORS_MAX_AGE_SECONDS', 'JWT_SECRET'] as const;
type CorsTestEnv = { [K in (typeof ENV_KEYS)[number]]?: string | undefined };

const FRONTEND = 'https://app.flowfi.xyz';
// auth.ts refuses to load in production without a 32+ byte secret.
const JWT_SECRET = 'cors-test-secret-that-is-at-least-32-bytes-long';

async function loadApp(env: CorsTestEnv): Promise<Express> {
    for (const key of ENV_KEYS) delete process.env[key];
    // Skip undefined values: assigning undefined to process.env stores the string "undefined".
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) process.env[key] = value;
    }
    vi.resetModules();
    const { default: freshApp } = await import('../src/app.js');
    return freshApp;
}

function loadProductionApp(env: CorsTestEnv = {}): Promise<Express> {
    return loadApp({ NODE_ENV: 'production', JWT_SECRET, FRONTEND_URL: FRONTEND, ...env });
}

describe('CORS policy', () => {
    const savedEnv: CorsTestEnv = {};

    beforeEach(() => {
        for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        vi.restoreAllMocks();
    });

    describe('production', () => {
        it('reflects an allowed origin and varies on Origin', async () => {
            const prodApp = await loadProductionApp();

            const response = await request(prodApp).get('/').set('Origin', FRONTEND);

            expect(response.status).toBe(200);
            expect(response.headers['access-control-allow-origin']).toBe(FRONTEND);
            expect(response.headers['access-control-allow-credentials']).toBe('true');
            expect(response.headers.vary).toMatch(/\bOrigin\b/);
        });

        it('rejects a disallowed origin with a 403 JSON error, no Allow-Origin, and a warning log', async () => {
            const prodApp = await loadProductionApp();
            const { default: logger } = await import('../src/logger.js');
            const warn = vi.spyOn(logger, 'warn');

            const response = await request(prodApp).get('/').set('Origin', 'https://evil.example');

            expect(response.status).toBe(403);
            expect(response.headers['content-type']).toMatch(/application\/json/);
            expect(response.body).toEqual({ error: 'CORS origin not allowed' });
            expect(response.headers['access-control-allow-origin']).toBeUndefined();
            expect(warn).toHaveBeenCalledWith(
                'CORS origin rejected',
                expect.objectContaining({ origin: 'https://evil.example', method: 'GET', path: '/' }),
            );
        });

        it.each([
            ['frontend host under another domain', 'https://app.flowfi.xyz.evil.com'],
            ['http instead of https', 'http://app.flowfi.xyz'],
            ['different port', 'https://app.flowfi.xyz:8443'],
            ['subdomain of the frontend', 'https://evil.app.flowfi.xyz'],
            ['shared suffix', 'https://evilapp.flowfi.xyz'],
            ['parent domain', 'https://flowfi.xyz'],
            ['trailing slash', 'https://app.flowfi.xyz/'],
            ['uppercase host', 'https://APP.flowfi.xyz'],
            ['opaque origin', 'null'],
        ])('rejects a lookalike origin (%s)', async (_label, origin) => {
            const prodApp = await loadProductionApp();

            const response = await request(prodApp).get('/').set('Origin', origin);

            expect(response.status).toBe(403);
            expect(response.headers['access-control-allow-origin']).toBeUndefined();
        });

        it('matches a configured origin written with a trailing slash or path', async () => {
            const prodApp = await loadProductionApp({ FRONTEND_URL: 'https://app.flowfi.xyz/dashboard/' });

            const response = await request(prodApp).get('/').set('Origin', FRONTEND);

            expect(response.status).toBe(200);
            expect(response.headers['access-control-allow-origin']).toBe(FRONTEND);
        });

        it('passes requests without an Origin header through without CORS headers', async () => {
            const prodApp = await loadProductionApp();

            const response = await request(prodApp).get('/');

            expect(response.status).toBe(200);
            expect(response.text).toBe('FlowFi Backend is running');
            expect(response.headers['access-control-allow-origin']).toBeUndefined();
        });

        it('answers an allowed preflight with 204 and cacheable method/header lists', async () => {
            const prodApp = await loadProductionApp();

            const response = await request(prodApp)
                .options('/v1/webhooks/abc')
                .set('Origin', FRONTEND)
                .set('Access-Control-Request-Method', 'PATCH')
                .set('Access-Control-Request-Headers', 'content-type,authorization,x-request-id');

            expect(response.status).toBe(204);
            expect(response.headers['access-control-allow-origin']).toBe(FRONTEND);
            expect(response.headers['access-control-allow-methods']).toBe('GET,POST,PUT,PATCH,DELETE,OPTIONS');
            expect(response.headers['access-control-allow-headers']).toBe('Content-Type,Authorization,X-Request-ID');
            expect(response.headers['access-control-max-age']).toBe('7200');
        });

        it('uses CORS_MAX_AGE_SECONDS for the preflight max-age', async () => {
            const prodApp = await loadProductionApp({ CORS_MAX_AGE_SECONDS: '600' });

            const response = await request(prodApp)
                .options('/v1/streams')
                .set('Origin', FRONTEND)
                .set('Access-Control-Request-Method', 'POST');

            expect(response.headers['access-control-max-age']).toBe('600');
        });

        it('does not permit headers or methods outside the allowlist', async () => {
            const prodApp = await loadProductionApp();

            const response = await request(prodApp)
                .options('/v1/streams')
                .set('Origin', FRONTEND)
                .set('Access-Control-Request-Method', 'TRACE')
                .set('Access-Control-Request-Headers', 'x-sandbox-mode,x-custom-header');

            // The browser compares the request against these lists and blocks the
            // actual request; the server must not echo the requested values back.
            expect(response.headers['access-control-allow-methods']).toBe('GET,POST,PUT,PATCH,DELETE,OPTIONS');
            expect(response.headers['access-control-allow-headers']).toBe('Content-Type,Authorization,X-Request-ID');
            expect(response.headers.vary ?? '').not.toMatch(/Access-Control-Request-Headers/i);
        });

        it('rejects a preflight from a disallowed origin', async () => {
            const prodApp = await loadProductionApp();

            const response = await request(prodApp)
                .options('/v1/streams')
                .set('Origin', 'https://evil.example')
                .set('Access-Control-Request-Method', 'POST');

            expect(response.status).toBe(403);
            expect(response.headers['access-control-allow-origin']).toBeUndefined();
            expect(response.headers['access-control-allow-methods']).toBeUndefined();
        });

        it('answers preflights for authenticated routes without running auth', async () => {
            const prodApp = await loadProductionApp();

            // The route itself requires a Bearer token...
            const unauthenticated = await request(prodApp).get('/v1/users/me').set('Origin', FRONTEND);
            expect(unauthenticated.status).toBe(401);

            // ...but its preflight is answered by CORS before auth runs.
            const preflight = await request(prodApp)
                .options('/v1/users/me')
                .set('Origin', FRONTEND)
                .set('Access-Control-Request-Method', 'GET')
                .set('Access-Control-Request-Headers', 'authorization');

            expect(preflight.status).toBe(204);
            expect(preflight.headers['access-control-allow-origin']).toBe(FRONTEND);
        });

        it('allows each of several comma-separated origins and rejects others', async () => {
            const prodApp = await loadProductionApp({
                FRONTEND_URL: `${FRONTEND}, https://preview.flowfi.xyz`,
            });

            for (const origin of [FRONTEND, 'https://preview.flowfi.xyz']) {
                const response = await request(prodApp).get('/').set('Origin', origin);
                expect(response.status).toBe(200);
                expect(response.headers['access-control-allow-origin']).toBe(origin);
            }

            const rejected = await request(prodApp).get('/').set('Origin', 'https://other.flowfi.xyz');
            expect(rejected.status).toBe(403);
        });

        it('still honours CORS_ALLOWED_ORIGINS for existing deployments', async () => {
            const prodApp = await loadProductionApp({ FRONTEND_URL: undefined, CORS_ALLOWED_ORIGINS: FRONTEND });

            const response = await request(prodApp).get('/').set('Origin', FRONTEND);

            expect(response.status).toBe(200);
            expect(response.headers['access-control-allow-origin']).toBe(FRONTEND);
        });

        it.each([
            ['missing', undefined],
            ['empty', ''],
        ])('refuses to start when FRONTEND_URL is %s', async (_label, value) => {
            await expect(loadProductionApp({ FRONTEND_URL: value })).rejects.toThrow(
                /FRONTEND_URL is required when NODE_ENV=production/,
            );
        });

        it.each(['*', 'app.flowfi.xyz', 'not a url'])('refuses to start when FRONTEND_URL is invalid (%j)', async (value) => {
            await expect(loadProductionApp({ FRONTEND_URL: value })).rejects.toThrow(/Invalid CORS origin/);
        });
    });

    describe('development', () => {
        it('keeps the existing allowlist with unrestricted headers and methods', async () => {
            const devApp = await loadApp({ NODE_ENV: 'development' });

            const response = await request(devApp)
                .options('/v1/streams')
                .set('Origin', 'http://localhost:3000')
                .set('Access-Control-Request-Method', 'POST')
                .set('Access-Control-Request-Headers', 'x-sandbox-mode');

            expect(response.status).toBe(204);
            expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
            expect(response.headers['access-control-allow-headers']).toBe('x-sandbox-mode');
            expect(response.headers['access-control-max-age']).toBeUndefined();
        });

        it('allows any origin listed in FRONTEND_URL', async () => {
            const devApp = await loadApp({ NODE_ENV: 'development', FRONTEND_URL: 'http://localhost:4000' });

            const response = await request(devApp).get('/').set('Origin', 'http://localhost:4000');

            expect(response.status).toBe(200);
            expect(response.headers['access-control-allow-origin']).toBe('http://localhost:4000');
        });

        it('starts without FRONTEND_URL', async () => {
            await expect(loadApp({ NODE_ENV: 'development' })).resolves.toBeDefined();
        });
    });
});
