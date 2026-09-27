/**
 * Tests for the Prometheus scrape endpoint (GET /metrics) and the shared
 * metrics registry.
 *
 * The route snapshots its access-control configuration at module load, so each
 * access-control case resets the module registry and re-imports the router with
 * a fresh environment.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../src/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const ENV_KEYS = [
  'METRICS_BEARER_TOKEN',
  'METRICS_ALLOWED_CIDRS',
  'NODE_ENV',
] as const;

/**
 * Matches a counter in `getMetricsAsJSON()` output.
 *
 * prom-client's bundled type declarations say `type` is a numeric `MetricType`
 * enum, but the implementation actually serialises the metric-type *name*, so
 * the value is the string `"counter"`. `String(...)` reconciles the two so the
 * comparison is both correct at runtime and accepted by the type checker.
 */
const isCounter = (metric: { type: unknown }): boolean => String(metric.type) === 'counter';

/** Mount only the metrics router, so the case under test is not shadowed by app-wide middleware. */
async function mountMetricsApp(): Promise<express.Express> {
  vi.resetModules();
  const { default: metricsRoutes } = await import('../src/routes/metrics.routes.js');
  const app = express();
  app.use('/metrics', metricsRoutes);
  return app;
}

describe('GET /metrics', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('serves the registry in development when no guard is configured', async () => {
    delete process.env.METRICS_BEARER_TOKEN;
    delete process.env.METRICS_ALLOWED_CIDRS;
    process.env.NODE_ENV = 'test';

    const res = await request(await mountMetricsApp()).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('flowfi_');
  });

  it('is disabled in production when no guard is configured', async () => {
    delete process.env.METRICS_BEARER_TOKEN;
    delete process.env.METRICS_ALLOWED_CIDRS;
    process.env.NODE_ENV = 'production';

    const res = await request(await mountMetricsApp()).get('/metrics');

    // 404 rather than 403: the endpoint should not advertise its existence.
    expect(res.status).toBe(404);
  });

  describe('bearer token guard', () => {
    beforeEach(() => {
      process.env.METRICS_BEARER_TOKEN = 's3cret-scraper-token';
      process.env.NODE_ENV = 'production';
    });

    it('rejects a request with no Authorization header', async () => {
      const res = await request(await mountMetricsApp()).get('/metrics');
      expect(res.status).toBe(403);
    });

    it('rejects a wrong token', async () => {
      const res = await request(await mountMetricsApp())
        .get('/metrics')
        .set('Authorization', 'Bearer wrong-token');
      expect(res.status).toBe(403);
    });

    it('rejects a non-Bearer scheme', async () => {
      const res = await request(await mountMetricsApp())
        .get('/metrics')
        .set('Authorization', 'Basic s3cret-scraper-token');
      expect(res.status).toBe(403);
    });

    it('accepts the configured token', async () => {
      const res = await request(await mountMetricsApp())
        .get('/metrics')
        .set('Authorization', 'Bearer s3cret-scraper-token');
      expect(res.status).toBe(200);
    });

    it('does not echo the expected token in the denial body', async () => {
      const res = await request(await mountMetricsApp()).get('/metrics');
      expect(res.text).not.toContain('s3cret-scraper-token');
    });
  });

  describe('CIDR guard', () => {
    // supertest connects over loopback, so the server sees ::ffff:127.0.0.1.
    it('accepts a scraper inside the allowlisted range', async () => {
      process.env.METRICS_ALLOWED_CIDRS = '127.0.0.0/8';
      process.env.NODE_ENV = 'production';

      const res = await request(await mountMetricsApp()).get('/metrics');
      expect(res.status).toBe(200);
    });

    it('rejects a scraper outside the allowlisted range', async () => {
      process.env.METRICS_ALLOWED_CIDRS = '10.0.0.0/8';
      process.env.NODE_ENV = 'production';

      const res = await request(await mountMetricsApp()).get('/metrics');
      expect(res.status).toBe(403);
    });

    it('ignores malformed CIDRs without opening the endpoint to everything', async () => {
      process.env.METRICS_ALLOWED_CIDRS = 'not-a-cidr,300.300.300.300/99';
      process.env.NODE_ENV = 'production';

      const res = await request(await mountMetricsApp()).get('/metrics');
      // Nothing valid was registered, so loopback does not match.
      expect(res.status).toBe(403);
    });

    it('honours a bare address entry without a prefix', async () => {
      process.env.METRICS_ALLOWED_CIDRS = '127.0.0.1';
      process.env.NODE_ENV = 'production';

      const res = await request(await mountMetricsApp()).get('/metrics');
      expect(res.status).toBe(200);
    });

    it('tolerates whitespace around comma-separated entries', async () => {
      process.env.METRICS_ALLOWED_CIDRS = ' 10.0.0.0/8 ,  127.0.0.0/8  ';
      process.env.NODE_ENV = 'production';

      const res = await request(await mountMetricsApp()).get('/metrics');
      expect(res.status).toBe(200);
    });
  });

  describe('when both guards are configured', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      process.env.METRICS_BEARER_TOKEN = 's3cret-scraper-token';
      // Loopback is deliberately NOT in the allowlist.
      process.env.METRICS_ALLOWED_CIDRS = '10.0.0.0/8';
    });

    it('requires both to pass, not either', async () => {
      const res = await request(await mountMetricsApp())
        .get('/metrics')
        .set('Authorization', 'Bearer s3cret-scraper-token');

      // Valid token but disallowed source network: defence in depth means a
      // leaked token is useless from outside the monitoring network.
      expect(res.status).toBe(403);
    });

    it('still requires the token once the network check passes', async () => {
      process.env.METRICS_ALLOWED_CIDRS = '127.0.0.0/8';

      expect((await request(await mountMetricsApp()).get('/metrics')).status).toBe(403);
      expect(
        (await request(await mountMetricsApp()).get('/metrics')
          .set('Authorization', 'Bearer s3cret-scraper-token')).status,
      ).toBe(200);
    });
  });
});

describe('rate limiter exemption', () => {
  /**
   * Behavioural, not introspective: a 429 on the scrape path would make
   * Prometheus mark the target down and blind the whole alerting pipeline, so
   * the exemption has to hold under sustained scrape traffic.
   */
  async function appWithLimiter(): Promise<express.Express> {
    const { globalRateLimiter } = await import('../src/middleware/rate-limiter.middleware.js');
    const app = express();
    app.use(globalRateLimiter);
    app.get('/metrics', (_req, res) => {
      res.type('text/plain').send('flowfi_up 1');
    });
    app.get('/v1/streams', (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  it('never throttles the scrape path', async () => {
    const app = await appWithLimiter();

    const statuses = await Promise.all(
      Array.from({ length: 130 }, () => request(app).get('/metrics')),
    );

    // The limiter allows 100/minute; scrapes must all get through regardless.
    expect(statuses.some((r) => r.status === 429)).toBe(false);
  });

  it('still throttles ordinary API traffic', async () => {
    const app = await appWithLimiter();

    const statuses = await Promise.all(
      Array.from({ length: 130 }, () => request(app).get('/v1/streams')),
    );

    expect(statuses.some((r) => r.status === 429)).toBe(true);
  });
});

describe('metrics registry', () => {
  it('exports every metric the dashboard and alerts depend on', async () => {
    const { getMetricsRegistry } = await import('../src/lib/metrics.js');
    const body = await getMetricsRegistry().metrics();

    for (const name of [
      'flowfi_indexer_current_ledger',
      'flowfi_indexer_network_ledger',
      'flowfi_indexer_lag_ledgers',
      'flowfi_sse_active_connections',
      'flowfi_sse_max_connections',
      'flowfi_rpc_request_duration_seconds',
      'flowfi_db_query_duration_seconds',
      'flowfi_http_requests_total',
      'flowfi_http_request_duration_seconds',
      'flowfi_indexer_polls_total',
      'flowfi_indexer_events_processed_total',
      'flowfi_rpc_failovers_total',
      'flowfi_rpc_circuit_breaker_trips_total',
      'flowfi_sse_clients_dropped_total',
      'flowfi_db_pool_connections',
    ]) {
      expect(body, `missing metric: ${name}`).toContain(name);
    }
  });

  it('reports the default Node process metrics', async () => {
    const { getMetricsRegistry } = await import('../src/lib/metrics.js');
    const body = await getMetricsRegistry().metrics();
    expect(body).toMatch(/flowfi_process_/);
  });

  it('exposes the total SSE topic as a reserved aggregate label', async () => {
    const { TOTAL_SSE_TOPIC } = await import('../src/lib/metrics.js');
    expect(TOTAL_SSE_TOPIC).toBe('total');
  });
});

describe('normalizeRoute', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  /** Build a request-like object good enough for the normalizer. */
  function fakeReq(path: string, routePath?: unknown, baseUrl = '') {
    return { path, baseUrl, route: routePath === undefined ? undefined : { path: routePath } };
  }

  it('prefers the matched express route pattern', async () => {
    const { normalizeRoute } = await import('../src/middleware/metrics.middleware.js');
    expect(normalizeRoute(fakeReq('/v1/streams/42/events', '/streams/:streamId/events', '/v1') as never))
      .toBe('/v1/streams/:streamId/events');
  });

  it('joins the base url and an array route pattern', async () => {
    const { normalizeRoute } = await import('../src/middleware/metrics.middleware.js');
    expect(normalizeRoute(fakeReq('/v1/x', ['/a', '/b'], '/v1') as never)).toBe('/v1/a/b');
  });

  it('falls back to collapsing numeric segments', async () => {
    const { normalizeRoute } = await import('../src/middleware/metrics.middleware.js');
    expect(normalizeRoute(fakeReq('/v1/streams/42/events') as never))
      .toBe('/v1/streams/:id/events');
  });

  it('collapses UUID segments on every call, not every other one', async () => {
    const { normalizeRoute } = await import('../src/middleware/metrics.middleware.js');
    const path = '/v1/streams/550e8400-e29b-41d4-a716-446655440000/events';

    // A stateful /g regex would fail on the second call and leak the raw UUID.
    for (let i = 0; i < 5; i += 1) {
      expect(normalizeRoute(fakeReq(path) as never)).toBe('/v1/streams/:uuid/events');
    }
  });

  it('collapses long hex segments on every call, not every other one', async () => {
    const { normalizeRoute } = await import('../src/middleware/metrics.middleware.js');
    const path = `/v1/tx/${'a'.repeat(64)}`;

    for (let i = 0; i < 5; i += 1) {
      expect(normalizeRoute(fakeReq(path) as never)).toBe('/v1/tx/:hash');
    }
  });

  it('leaves short hex segments alone', async () => {
    const { normalizeRoute } = await import('../src/middleware/metrics.middleware.js');
    expect(normalizeRoute(fakeReq('/v1/deadbeef') as never)).toBe('/v1/deadbeef');
  });

  it('handles the root path and does not emit a leading double slash', async () => {
    const { normalizeRoute } = await import('../src/middleware/metrics.middleware.js');
    expect(normalizeRoute(fakeReq('/') as never)).toBe('/');
    expect(normalizeRoute(fakeReq('/', '/') as never)).toBe('/');
  });
});

describe('metrics middleware', () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it('collapses many distinct resource ids into a single label set', async () => {
    const { metricsMiddleware } = await import('../src/middleware/metrics.middleware.js');
    const { getMetricsRegistry } = await import('../src/lib/metrics.js');

    const app = express();
    app.use(metricsMiddleware);
    const router = express.Router();
    router.get('/streams/:streamId/events', (_req, res) => {
      res.json({ ok: true });
    });
    app.use('/v1', router);

    for (let i = 0; i < 25; i += 1) {
      await request(app).get(`/v1/streams/${i}/events`);
    }

    const series = await getMetricsRegistry().getMetricsAsJSON();
    const counter = series.find((m) => isCounter(m) && m.name.includes('http_request'));
    const routes = new Set(counter?.values.map((v) => v.labels.route));

    expect(routes).toEqual(new Set(['/v1/streams/:streamId/events']));
    expect(counter?.values[0]?.labels.status).toBe('200');
  });

  it('records a request whose client disconnects before the response finishes', async () => {
    const { metricsMiddleware } = await import('../src/middleware/metrics.middleware.js');
    const { getMetricsRegistry } = await import('../src/lib/metrics.js');

    // Driven with fake req/res rather than a real socket: `finish` never fires
    // on an aborted response, so this exercises the `close` fallback directly.
    const res = new EventEmitter() as EventEmitter & {
      statusCode: number;
      writableFinished: boolean;
    };
    res.statusCode = 200;
    res.writableFinished = false;

    let nextCalled = false;
    metricsMiddleware(
      { method: 'GET', path: '/v1/streams/7/events', baseUrl: '', route: undefined } as never,
      res as never,
      (() => {
        nextCalled = true;
      }) as never,
    );
    expect(nextCalled).toBe(true);

    res.emit('close');

    const series = await getMetricsRegistry().getMetricsAsJSON();
    const counter = series.find((m) => isCounter(m) && m.name.includes('http_request'));
    const aborted = counter?.values.filter((v) => v.labels.route === '/v1/streams/:id/events');
    expect(aborted).toHaveLength(1);
    expect(aborted?.[0]?.labels.status).toBe('200');
  });

  it('does not double-count a completed request', async () => {
    const { metricsMiddleware } = await import('../src/middleware/metrics.middleware.js');
    const { getMetricsRegistry } = await import('../src/lib/metrics.js');

    const res = new EventEmitter() as EventEmitter & {
      statusCode: number;
      writableFinished: boolean;
    };
    res.statusCode = 201;
    res.writableFinished = true;

    metricsMiddleware(
      { method: 'POST', path: '/v1/streams', baseUrl: '', route: { path: '/streams' } } as never,
      res as never,
      (() => {}) as never,
    );

    // `close` always fires, even after a clean `finish`; the writableFinished
    // guard is what stops the request being counted twice.
    res.emit('finish');
    res.emit('close');

    const series = await getMetricsRegistry().getMetricsAsJSON();
    const counter = series.find((m) => isCounter(m) && m.name.includes('http_request'));
    const created = counter?.values.filter((v) => v.labels.route === '/streams');
    expect(created).toHaveLength(1);
  });
});
