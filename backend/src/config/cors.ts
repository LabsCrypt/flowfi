/**
 * CORS Configuration
 *
 * Builds the options for the `cors` middleware from environment variables.
 * The options are resolved when the app is created (not per request), so a
 * misconfigured production deployment fails at startup instead of serving
 * traffic with the wrong policy.
 *
 * Production (NODE_ENV=production):
 * - Only the origins listed in FRONTEND_URL / CORS_ALLOWED_ORIGINS are allowed,
 *   compared by exact match after normalising each entry to its origin.
 * - Allowed request headers and methods are restricted to what the API uses.
 * - Preflight responses are cacheable for CORS_MAX_AGE_SECONDS.
 * - A missing or invalid origin list throws: the app never falls back to a
 *   permissive policy.
 *
 * Any other NODE_ENV keeps the development policy: the configured origins (or
 * http://localhost:3000 when none are set), with request headers and methods
 * left unrestricted.
 *
 * Requests without an Origin header (webhooks, health checks, curl,
 * server-to-server calls) are never rejected: CORS is enforced by browsers, and
 * browsers always send Origin on cross-origin requests.
 */
import type { CorsOptions } from 'cors';
import logger from '../logger.js';

export const DEFAULT_DEV_ORIGIN = 'http://localhost:3000';

/**
 * How long browsers may cache a preflight response. Browsers cap this value
 * (Chromium at 2 hours, Firefox at 24 hours), so larger values are ignored.
 */
export const DEFAULT_CORS_MAX_AGE_SECONDS = 7200;

export const PRODUCTION_ALLOWED_HEADERS = ['Content-Type', 'Authorization', 'X-Request-ID'];

// PATCH is not in the list from issue #1491, but the frontend updates webhook
// subscriptions with PATCH /v1/webhooks/:id, so leaving it out would break that flow.
export const PRODUCTION_ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** Raised by the origin check when a browser request comes from an origin that is not allowed. */
export class CorsError extends Error {
  readonly statusCode = 403;
  readonly origin: string;

  constructor(origin: string) {
    super('CORS origin not allowed');
    this.name = 'CorsError';
    this.origin = origin;
  }
}

/**
 * Reduce a configured URL to its origin (scheme + host + port), which is the
 * form browsers send in the Origin header. Returns null for anything that is
 * not an absolute http(s) URL without credentials.
 */
export function normalizeOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;

  return url.origin;
}

interface ParsedOrigins {
  origins: string[];
  invalid: string[];
}

function parseOriginList(...values: Array<string | undefined>): ParsedOrigins {
  const origins = new Set<string>();
  const invalid: string[] = [];

  for (const value of values) {
    if (!value) continue;
    for (const entry of value.split(',').map((item) => item.trim()).filter(Boolean)) {
      const origin = normalizeOrigin(entry);
      if (origin) origins.add(origin);
      else invalid.push(entry);
    }
  }

  return { origins: [...origins], invalid };
}

function parseMaxAge(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_CORS_MAX_AGE_SECONDS;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `CORS_MAX_AGE_SECONDS has invalid value '${value}'. Expected a non-negative integer number of seconds.`,
    );
  }
  return parsed;
}

function createOriginCheck(allowedOrigins: ReadonlySet<string>): CorsOptions['origin'] {
  return (origin, callback) => {
    // No Origin header: not a cross-origin browser request, so there is
    // nothing for CORS to enforce. Let it through without Allow-Origin.
    if (!origin) {
      callback(null, true);
      return;
    }

    // Exact match only: no prefix, suffix or pattern matching.
    if (allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(new CorsError(origin));
  };
}

/**
 * Reads NODE_ENV, FRONTEND_URL, CORS_ALLOWED_ORIGINS and CORS_MAX_AGE_SECONDS.
 * Throws in production when the origin list is missing or invalid.
 */
export function buildCorsOptions(env: NodeJS.ProcessEnv = process.env): CorsOptions {
  const { origins, invalid } = parseOriginList(env.FRONTEND_URL, env.CORS_ALLOWED_ORIGINS);

  if (env.NODE_ENV === 'production') {
    if (invalid.length > 0) {
      throw new Error(
        `Invalid CORS origin(s) in FRONTEND_URL/CORS_ALLOWED_ORIGINS: ${invalid.join(', ')}. ` +
          'Expected absolute http(s) URLs such as https://app.flowfi.xyz.',
      );
    }
    if (origins.length === 0) {
      throw new Error(
        'FRONTEND_URL is required when NODE_ENV=production: set it to the frontend origin ' +
          '(e.g. https://app.flowfi.xyz, comma-separate multiple origins). ' +
          'Refusing to start with an open CORS policy.',
      );
    }

    return {
      origin: createOriginCheck(new Set(origins)),
      credentials: true,
      methods: PRODUCTION_ALLOWED_METHODS,
      allowedHeaders: PRODUCTION_ALLOWED_HEADERS,
      maxAge: parseMaxAge(env.CORS_MAX_AGE_SECONDS),
      optionsSuccessStatus: 204,
    };
  }

  if (!env.NODE_ENV) {
    logger.warn(
      'NODE_ENV is not set; using the development CORS policy. Set NODE_ENV=production in deployed environments.',
    );
  }
  if (invalid.length > 0) {
    logger.warn('Ignoring invalid CORS origin(s) in FRONTEND_URL/CORS_ALLOWED_ORIGINS', { invalid });
  }

  const devOrigins = env.FRONTEND_URL || env.CORS_ALLOWED_ORIGINS ? origins : [DEFAULT_DEV_ORIGIN];

  return {
    origin: createOriginCheck(new Set(devOrigins)),
    credentials: true,
  };
}
