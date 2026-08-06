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

import app from '../src/app.js';
import { sorobanEventWorker } from '../src/workers/soroban-event-worker.js';

function makeState(lagSeconds: number) {
  const updatedAt = new Date(Date.now() - lagSeconds * 1000);
  return { id: 'singleton', updatedAt };
}

describe('GET /health', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
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
  });

  it('returns 200 when DB is up, indexer enabled, and lag is within threshold', async () => {
    vi.stubEnv('STREAM_CONTRACT_ID', 'CSOME_CONTRACT_ADDRESS');
    prismaMock.indexerState.findUnique.mockResolvedValue(makeState(30));

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.indexerLag).toBeGreaterThanOrEqual(0);
    expect(res.body.indexerLag).toBeLessThanOrEqual(60);
  });

  it('returns 503 when DB is up, indexer enabled, and lag exceeds 60 s', async () => {
    vi.stubEnv('STREAM_CONTRACT_ID', 'CSOME_CONTRACT_ADDRESS');
    prismaMock.indexerState.findUnique.mockResolvedValue(makeState(120));

    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.indexerLag).toBeGreaterThan(60);
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
  });
});
