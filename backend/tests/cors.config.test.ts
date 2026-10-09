import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CorsOptions } from 'cors';

vi.mock('../src/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import logger from '../src/logger.js';
import {
  buildCorsOptions,
  normalizeOrigin,
  CorsError,
  DEFAULT_CORS_MAX_AGE_SECONDS,
} from '../src/config/cors.js';

const FRONTEND = 'https://app.flowfi.xyz';

/** Run the configured origin callback the way the cors middleware does. */
function checkOrigin(
  options: CorsOptions,
  origin: string | undefined,
): Promise<{ err: Error | null; allowed: unknown }> {
  const check = options.origin;
  if (typeof check !== 'function') throw new Error('expected an origin callback');
  return new Promise((resolve) => {
    check(origin, (err, allowed) => resolve({ err, allowed }));
  });
}

describe('normalizeOrigin', () => {
  it.each([
    ['https://app.flowfi.xyz', 'https://app.flowfi.xyz'],
    ['https://app.flowfi.xyz/', 'https://app.flowfi.xyz'],
    ['https://app.flowfi.xyz/dashboard?tab=1#top', 'https://app.flowfi.xyz'],
    ['  https://APP.FlowFi.xyz  ', 'https://app.flowfi.xyz'],
    ['https://app.flowfi.xyz:443', 'https://app.flowfi.xyz'],
    ['http://localhost:3000/', 'http://localhost:3000'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });

  it.each(['*', 'app.flowfi.xyz', 'not a url', 'ftp://app.flowfi.xyz', 'javascript:alert(1)', 'https://user:pass@app.flowfi.xyz', ''])(
    'rejects %j',
    (input) => {
      expect(normalizeOrigin(input)).toBeNull();
    },
  );
});

describe('buildCorsOptions (production)', () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  it('restricts methods, headers and caches preflights', () => {
    const options = buildCorsOptions({ NODE_ENV: 'production', FRONTEND_URL: FRONTEND });

    expect(options.methods).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
    expect(options.allowedHeaders).toEqual(['Content-Type', 'Authorization', 'X-Request-ID']);
    expect(options.maxAge).toBe(DEFAULT_CORS_MAX_AGE_SECONDS);
    expect(options.optionsSuccessStatus).toBe(204);
    expect(options.credentials).toBe(true);
  });

  it('allows the configured origin by exact match', async () => {
    const options = buildCorsOptions({ NODE_ENV: 'production', FRONTEND_URL: FRONTEND });

    await expect(checkOrigin(options, FRONTEND)).resolves.toEqual({ err: null, allowed: true });
  });

  it('allows requests without an Origin header', async () => {
    const options = buildCorsOptions({ NODE_ENV: 'production', FRONTEND_URL: FRONTEND });

    await expect(checkOrigin(options, undefined)).resolves.toEqual({ err: null, allowed: true });
  });

  it('rejects other origins with a CorsError', async () => {
    const options = buildCorsOptions({ NODE_ENV: 'production', FRONTEND_URL: FRONTEND });

    const { err } = await checkOrigin(options, 'https://evil.example');
    expect(err).toBeInstanceOf(CorsError);
    expect((err as CorsError).origin).toBe('https://evil.example');
    expect((err as CorsError).statusCode).toBe(403);
  });

  it('merges FRONTEND_URL and CORS_ALLOWED_ORIGINS', async () => {
    const options = buildCorsOptions({
      NODE_ENV: 'production',
      FRONTEND_URL: `${FRONTEND}, https://preview.flowfi.xyz`,
      CORS_ALLOWED_ORIGINS: 'https://flowfi.xyz',
    });

    for (const origin of [FRONTEND, 'https://preview.flowfi.xyz', 'https://flowfi.xyz']) {
      await expect(checkOrigin(options, origin)).resolves.toEqual({ err: null, allowed: true });
    }
  });

  it('accepts CORS_ALLOWED_ORIGINS alone for existing deployments', async () => {
    const options = buildCorsOptions({ NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: FRONTEND });

    await expect(checkOrigin(options, FRONTEND)).resolves.toEqual({ err: null, allowed: true });
  });

  it.each([
    [{}],
    [{ FRONTEND_URL: '' }],
    [{ FRONTEND_URL: ' , ' }],
  ])('throws when no origin is configured (%j)', (env) => {
    expect(() => buildCorsOptions({ NODE_ENV: 'production', ...env })).toThrow(
      /FRONTEND_URL is required when NODE_ENV=production/,
    );
  });

  it.each(['*', 'app.flowfi.xyz', 'ftp://app.flowfi.xyz'])('throws on invalid FRONTEND_URL %j', (value) => {
    expect(() => buildCorsOptions({ NODE_ENV: 'production', FRONTEND_URL: value })).toThrow(/Invalid CORS origin/);
  });

  it('throws when one entry of a list is invalid', () => {
    expect(() =>
      buildCorsOptions({ NODE_ENV: 'production', FRONTEND_URL: `${FRONTEND},*` }),
    ).toThrow(/Invalid CORS origin\(s\) in FRONTEND_URL\/CORS_ALLOWED_ORIGINS: \*/);
  });

  it('reads the preflight max-age from CORS_MAX_AGE_SECONDS', () => {
    const options = buildCorsOptions({
      NODE_ENV: 'production',
      FRONTEND_URL: FRONTEND,
      CORS_MAX_AGE_SECONDS: '600',
    });

    expect(options.maxAge).toBe(600);
  });

  it.each(['abc', '-1', '1.5'])('throws on invalid CORS_MAX_AGE_SECONDS %j', (value) => {
    expect(() =>
      buildCorsOptions({ NODE_ENV: 'production', FRONTEND_URL: FRONTEND, CORS_MAX_AGE_SECONDS: value }),
    ).toThrow(/CORS_MAX_AGE_SECONDS/);
  });
});

describe('buildCorsOptions (development)', () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  it('leaves headers, methods and max-age unrestricted', () => {
    const options = buildCorsOptions({ NODE_ENV: 'development' });

    expect(options.methods).toBeUndefined();
    expect(options.allowedHeaders).toBeUndefined();
    expect(options.maxAge).toBeUndefined();
    expect(options.credentials).toBe(true);
  });

  it('defaults to the local frontend dev server when no origin is configured', async () => {
    const options = buildCorsOptions({ NODE_ENV: 'development' });

    await expect(checkOrigin(options, 'http://localhost:3000')).resolves.toEqual({ err: null, allowed: true });
    expect((await checkOrigin(options, 'https://evil.example')).err).toBeInstanceOf(CorsError);
  });

  it('uses the configured origins instead of the default when set', async () => {
    const options = buildCorsOptions({ NODE_ENV: 'development', FRONTEND_URL: 'http://localhost:4000' });

    await expect(checkOrigin(options, 'http://localhost:4000')).resolves.toEqual({ err: null, allowed: true });
    expect((await checkOrigin(options, 'http://localhost:3000')).err).toBeInstanceOf(CorsError);
  });

  it('does not throw on a missing or invalid origin list', () => {
    expect(() => buildCorsOptions({ NODE_ENV: 'development', FRONTEND_URL: '*' })).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      'Ignoring invalid CORS origin(s) in FRONTEND_URL/CORS_ALLOWED_ORIGINS',
      { invalid: ['*'] },
    );
  });

  it('warns when NODE_ENV is unset', () => {
    buildCorsOptions({});

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('NODE_ENV is not set'));
  });

  it('does not warn about NODE_ENV when it is set', () => {
    buildCorsOptions({ NODE_ENV: 'test' });

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
