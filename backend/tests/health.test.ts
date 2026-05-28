import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Prisma mock — replaced per test to simulate DB up/down and indexer state.
const prismaMock = {
  $queryRaw: vi.fn(),
  indexerState: {
    findUnique: vi.fn(),
  },
};

vi.mock('../src/lib/prisma.js', () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

import app from '../src/app.js';

function makeState(lagSeconds: number) {
  const updatedAt = new Date(Date.now() - lagSeconds * 1000);
  return { id: 'singleton', updatedAt };
}

describe('GET /health', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    prismaMock.$queryRaw.mockResolvedValue([{ '?column?': 1n }]);
    prismaMock.indexerState.findUnique.mockResolvedValue(null);
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
});
