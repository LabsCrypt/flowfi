import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Prisma mock — replaced per test to simulate DB up/down and indexer state.
// Defined via vi.hoisted so it exists when the hoisted vi.mock factory runs.
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    $queryRaw: vi.fn(),
    indexerState: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

vi.mock('../src/workers/soroban-event-worker.js', () => ({
  sorobanEventWorker: {
    getEventCounters: vi.fn().mockReturnValue({
      eventsProcessed: 0,
      eventsFailed: 0,
      lastErrorAt: null,
      degraded: false,
    }),
  },
  SorobanEventWorker: vi.fn(),
}));

// Redis client — replaced per test; null means "never connected".
vi.mock('../src/lib/redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/redis.js')>()),
  getPublisher: vi.fn(() => null),
}));

// Keep the health route off the network: no real Soroban RPC calls.
vi.mock('../src/services/sorobanService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/sorobanService.js')>()),
  checkRpcHealth: vi.fn(async () => true),
  getLatestLedger: vi.fn(async () => 0),
}));

import type { Redis } from 'ioredis';
import app from '../src/app.js';
import logger from '../src/logger.js';
import { getPublisher } from '../src/lib/redis.js';
import { checkRpcHealth } from '../src/services/sorobanService.js';
import { sorobanEventWorker } from '../src/workers/soroban-event-worker.js';

function makeState(lagSeconds: number) {
  const updatedAt = new Date(Date.now() - lagSeconds * 1000);
  return { id: 'singleton', updatedAt };
}

const never = <T>() => new Promise<T>(() => undefined);

/** A Redis client stub exposing only what the health route uses. */
function mockRedis(ping: () => Promise<string>, status = 'ready') {
  const client = { status, ping: vi.fn(ping) };
  vi.mocked(getPublisher).mockReturnValue(client as unknown as Redis);
  return client;
}

/**
 * Send GET /health while driving a fake clock (only setTimeout is faked) in
 * 10 ms steps, yielding real event-loop turns in between so socket I/O makes
 * progress. Returns the response and how much simulated time it needed.
 */
async function getHealthWithFakeClock() {
  const stepMs = 10;
  let done = false;
  const pending = request(app)
    .get('/health')
    .then((res) => {
      done = true;
      return res;
    });

  let elapsedMs = 0;
  while (!done) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (done) break;
    await vi.advanceTimersByTimeAsync(stepMs);
    elapsedMs += stepMs;
    if (elapsedMs > 5_000) throw new Error('/health did not respond within 5 s of simulated time');
  }

  return { res: await pending, elapsedMs };
}

describe('GET /health', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('REDIS_URL', '');
    vi.mocked(getPublisher).mockReturnValue(null);
    vi.mocked(checkRpcHealth).mockResolvedValue(true);
    prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1n }]);
    prismaMock.indexerState.findUnique.mockResolvedValue(null);
    vi.mocked(sorobanEventWorker.getEventCounters).mockReturnValue({
      eventsProcessed: 0,
      eventsFailed: 0,
      lastErrorAt: null,
      degraded: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 when DB is up and indexer is disabled (no STREAM_CONTRACT_ID)', async () => {
    vi.stubEnv('STREAM_CONTRACT_ID', '');

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('connected');
    expect(res.body.indexerEnabled).toBe(false);
    expect(res.body.checks.indexer.status).toBe('disabled');
    expect(res.body.indexerLag).toBeNull();
    expect(res.body.eventsProcessed).toBe(0);
    expect(res.body.eventsFailed).toBe(0);
    expect(res.body.lastErrorAt).toBeNull();
    expect(res.body.indexerDegraded).toBe(false);
  });

  it('returns 200 when DB is up and indexer is enabled but has no state row yet (cold start)', async () => {
    vi.stubEnv('STREAM_CONTRACT_ID', 'CSOME_CONTRACT_ADDRESS');
    prismaMock.indexerState.findUnique.mockResolvedValue(null);

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.indexerEnabled).toBe(true);
    expect(res.body.indexerLag).toBeNull();
    expect(res.body.checks.indexer.status).toBe('ok');
  });

  it('returns 200 when DB is up, indexer enabled, and lag is within threshold', async () => {
    vi.stubEnv('STREAM_CONTRACT_ID', 'CSOME_CONTRACT_ADDRESS');
    prismaMock.indexerState.findUnique.mockResolvedValue(makeState(30));

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.indexerLag).toBeGreaterThanOrEqual(0);
    expect(res.body.indexerLag).toBeLessThanOrEqual(60);
    expect(res.body.checks.indexer.status).toBe('ok');
  });

  it('returns 503 when DB is up, indexer enabled, and lag exceeds 60 s', async () => {
    vi.stubEnv('STREAM_CONTRACT_ID', 'CSOME_CONTRACT_ADDRESS');
    prismaMock.indexerState.findUnique.mockResolvedValue(makeState(120));

    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.indexerLag).toBeGreaterThan(60);
    expect(res.body.checks.indexer.status).toBe('degraded');
  });

  it('returns checks.indexer.status "degraded" for lag-only degradation, with failure-rate signals asserted healthy (#1294)', async () => {
    vi.stubEnv('STREAM_CONTRACT_ID', 'CSOME_CONTRACT_ADDRESS');
    prismaMock.indexerState.findUnique.mockResolvedValue(makeState(120));
    // Explicitly (re)assert the failure-rate counters are healthy so this
    // test isolates lag-only degradation rather than relying on beforeEach
    // defaults implicitly — the mismatch this test guards against is
    // checks.indexer.status staying "ok" while lag alone drives the
    // top-level status to "degraded".
    vi.mocked(sorobanEventWorker.getEventCounters).mockReturnValue({
      eventsProcessed: 42,
      eventsFailed: 0,
      lastErrorAt: null,
      degraded: false,
    });

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.indexerLag).toBeGreaterThan(60);
    // Failure-rate degradation is NOT a contributing factor.
    expect(res.body.eventsFailed).toBe(0);
    expect(res.body.indexerDegraded).toBe(false);
    // The granular breakdown must match the top-level verdict during a
    // lag-only incident.
    expect(res.body.checks.indexer.status).toBe('degraded');
    expect(res.body.checks.indexer.enabled).toBe(true);
    expect(res.body.checks.indexer.lagSeconds).toBeGreaterThan(60);
    expect(res.body.checks.database.status).toBe('ok');
  });

  it('returns 503 when DB is down regardless of indexer state', async () => {
    vi.stubEnv('STREAM_CONTRACT_ID', '');
    prismaMock.$queryRaw.mockRejectedValue(new Error('DB connection refused'));

    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.db).toBe('disconnected');
  });

  it('returns 200 with indexerLag in body for observability', async () => {
    vi.stubEnv('STREAM_CONTRACT_ID', 'CSOME_CONTRACT_ADDRESS');
    prismaMock.indexerState.findUnique.mockResolvedValue(makeState(10));

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(typeof res.body.indexerLag).toBe('number');
    expect(typeof res.body.uptime).toBe('number');
  });

  it('returns 503 when indexer is enabled and event-processing failures spike (#844)', async () => {
    vi.stubEnv('STREAM_CONTRACT_ID', 'CSOME_CONTRACT_ADDRESS');
    prismaMock.indexerState.findUnique.mockResolvedValue(makeState(5));
    vi.mocked(sorobanEventWorker.getEventCounters).mockReturnValue({
      eventsProcessed: 1,
      eventsFailed: 10,
      lastErrorAt: '2026-07-27T08:00:00.000Z',
      degraded: true,
    });

    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.indexerLag).toBeLessThanOrEqual(60);
    expect(res.body.eventsProcessed).toBe(1);
    expect(res.body.eventsFailed).toBe(10);
    expect(res.body.lastErrorAt).toBe('2026-07-27T08:00:00.000Z');
    expect(res.body.indexerDegraded).toBe(true);
    expect(res.body.checks.indexer.status).toBe('degraded');
  });
});

describe('GET /health dependency timeouts (#1492)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('STREAM_CONTRACT_ID', '');
    vi.stubEnv('REDIS_URL', 'redis://redis.internal:6379');
    vi.mocked(getPublisher).mockReturnValue(null);
    vi.mocked(checkRpcHealth).mockResolvedValue(true);
    prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1n }]);
    prismaMock.indexerState.findUnique.mockResolvedValue(null);
    vi.mocked(sorobanEventWorker.getEventCounters).mockReturnValue({
      eventsProcessed: 0,
      eventsFailed: 0,
      lastErrorAt: null,
      degraded: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('with a fake clock', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    it('answers at the timeout with redis "timeout" when the ping never resolves', async () => {
      mockRedis(never);

      const { res, elapsedMs } = await getHealthWithFakeClock();

      expect(elapsedMs).toBeGreaterThanOrEqual(800);
      expect(elapsedMs).toBeLessThan(900);
      // Redis is optional: liveness stays 200, the body reports the degradation.
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
      expect(res.body.redis).toBe('timeout');
      expect(res.body.checks.redis.status).toBe('timeout');
      expect(res.body.db).toBe('connected');
      expect(res.body.checks.database.status).toBe('ok');
    });

    it('honours HEALTHCHECK_TIMEOUT_MS', async () => {
      vi.stubEnv('HEALTHCHECK_TIMEOUT_MS', '300');
      mockRedis(never);

      const { res, elapsedMs } = await getHealthWithFakeClock();

      expect(elapsedMs).toBeGreaterThanOrEqual(300);
      expect(elapsedMs).toBeLessThan(400);
      expect(res.body.redis).toBe('timeout');
    });

    it('returns 503 with database "timeout" when the DB query hangs and Redis is fine', async () => {
      prismaMock.$queryRaw.mockImplementation(never);
      mockRedis(async () => 'PONG');

      const { res, elapsedMs } = await getHealthWithFakeClock();

      expect(elapsedMs).toBeLessThan(900);
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('degraded');
      expect(res.body.db).toBe('disconnected');
      expect(res.body.checks.database.status).toBe('timeout');
      expect(res.body.redis).toBe('ok');
    });

    it('runs the checks in parallel: two 700 ms probes take ~700 ms, not 1400 ms', async () => {
      const slow = <T>(value: T) => () => new Promise<T>((resolve) => setTimeout(() => resolve(value), 700));
      prismaMock.$queryRaw.mockImplementation(slow([{ '?column?': 1n }]));
      prismaMock.indexerState.findUnique.mockImplementation(slow(null));
      vi.mocked(checkRpcHealth).mockImplementation(slow(true));
      mockRedis(slow('PONG'));

      const { res, elapsedMs } = await getHealthWithFakeClock();

      expect(elapsedMs).toBeGreaterThanOrEqual(700);
      expect(elapsedMs).toBeLessThan(800);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.redis).toBe('ok');
    });

    it('does not wait on a hanging Soroban RPC health check', async () => {
      vi.mocked(checkRpcHealth).mockImplementation(never);
      mockRedis(async () => 'PONG');

      const { res, elapsedMs } = await getHealthWithFakeClock();

      expect(elapsedMs).toBeLessThan(900);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.checks.sorobanRpc.status).toBe('down');
    });
  });

  it('responds in under 1,000 ms of real time when Redis never answers', async () => {
    mockRedis(never);

    const started = performance.now();
    const res = await request(app).get('/health');
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(1000);
    expect(elapsedMs).toBeGreaterThanOrEqual(750);
    expect(res.status).toBe(200);
    expect(res.body.redis).toBe('timeout');
  });

  it('reports redis "unavailable" when the ping is rejected', async () => {
    mockRedis(async () => {
      throw new Error('Connection is closed.');
    });

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.redis).toBe('unavailable');
    expect(res.body.checks.redis.status).toBe('unavailable');
  });

  it.each(['reconnecting', 'connecting', 'end', 'close'])(
    'reports redis "unavailable" without pinging when the client is %s',
    async (clientStatus) => {
      const client = mockRedis(async () => 'PONG', clientStatus);

      const res = await request(app).get('/health');

      expect(res.body.redis).toBe('unavailable');
      expect(client.ping).not.toHaveBeenCalled();
    },
  );

  it('reports redis "unavailable" when REDIS_URL is set but no client connected', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.redis).toBe('unavailable');
  });

  it('reports redis "not_configured" and stays ok when REDIS_URL is unset', async () => {
    vi.stubEnv('REDIS_URL', '');

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.redis).toBe('not_configured');
  });

  it('returns 503 with database "down" when the DB query fails and Redis is fine', async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error('DB connection refused'));
    mockRedis(async () => 'PONG');

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.db).toBe('disconnected');
    expect(res.body.checks.database.status).toBe('down');
    expect(res.body.redis).toBe('ok');
  });

  it('reports both failures when the DB and Redis are down', async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error('DB connection refused'));
    mockRedis(async () => {
      throw new Error('Connection is closed.');
    });

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.database.status).toBe('down');
    expect(res.body.checks.redis.status).toBe('unavailable');
  });

  it('returns 200 "ok" with no-store caching when the DB and Redis are healthy', async () => {
    const client = mockRedis(async () => 'PONG');

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('connected');
    expect(res.body.redis).toBe('ok');
    expect(res.body.checks.database.status).toBe('ok');
    expect(res.body.checks.redis.status).toBe('ok');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(client.ping).toHaveBeenCalledTimes(1);
  });

  it('never leaks error messages or connection details in the response', async () => {
    prismaMock.$queryRaw.mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 postgresql://flowfi:s3cret@db.internal/flowfi'),
    );
    mockRedis(async () => {
      throw new Error('connect ECONNREFUSED redis://:s3cret@redis.internal:6379');
    });

    const res = await request(app).get('/health');
    const body = JSON.stringify(res.body);

    for (const secret of ['ECONNREFUSED', 's3cret', 'internal', '10.0.0.5', 'postgresql://', 'redis://']) {
      expect(body).not.toContain(secret);
    }
  });

  it('logs a failing component once, not on every probe', async () => {
    const warn = vi.spyOn(logger, 'warn');

    mockRedis(async () => 'PONG');
    await request(app).get('/health');

    mockRedis(async () => {
      throw new Error('Connection is closed.');
    });
    await request(app).get('/health');
    await request(app).get('/health');

    const messages = warn.mock.calls.map((call) => String(call[0]));
    const redisWarnings = messages.filter((message) => message === '[Health] redis check failing');
    expect(redisWarnings).toHaveLength(1);
  });
});
