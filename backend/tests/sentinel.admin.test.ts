/**
 * Admin sentinel API (Issue #1469).
 *
 * Mounts the real admin router behind a pass-through auth/rate-limit stub and
 * asserts the responder-facing contract: threat score, flagged addresses and
 * the incident feed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

vi.mock('../src/lib/prisma.js', () => ({ prisma: {}, pool: {} }));

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/middleware/auth.js', () => ({
  requireAdmin: (req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user: { publicKey: string } }).user = {
      publicKey: 'GADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    next();
  },
}));

vi.mock('../src/middleware/admin-rate-limiter.middleware.js', () => ({
  adminRateLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../src/services/sse.service.js', () => ({
  sseService: { getClientCount: () => 0, broadcastToAdmin: vi.fn() },
}));

vi.mock('../src/workers/soroban-event-worker.js', () => ({
  sorobanEventWorker: {
    getEventCounters: () => ({
      eventsProcessed: 0,
      eventsFailed: 0,
      lastErrorAt: null,
      degraded: false,
    }),
  },
}));

vi.mock('../src/services/indexerService.js', () => ({
  getIndexerStatus: vi.fn(),
  resetIndexer: vi.fn(),
  replayFromLedger: vi.fn(),
  previewReset: vi.fn(),
  previewReplay: vi.fn(),
  listDeadLetterEvents: vi.fn(),
  replayDeadLetterEvent: vi.fn(),
  replayAllDeadLetterEvents: vi.fn(),
  discardDeadLetterEvent: vi.fn(),
  DeadLetterNotFoundError: class DeadLetterNotFoundError extends Error {},
  DEFAULT_DEAD_LETTER_PAGE_SIZE: 25,
  MAX_DEAD_LETTER_PAGE_SIZE: 100,
}));

import adminRoutes from '../src/routes/v1/admin.routes.js';
import { getSentinelService } from '../src/services/sentinel.service.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/admin', adminRoutes);
  return app;
}

const ATTACKER = 'GATTACKERADMINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

async function raiseCritical(labels: { streamId?: string; txHash: string }) {
  return getSentinelService().recordWithdrawal({
    address: ATTACKER,
    token: 'CUSDC',
    amount: '1',
    amountUsd: 500_000,
    streamId: labels.streamId ?? '77',
    ledger: 9_001,
    txHash: labels.txHash,
  });
}

describe('GET /v1/admin/sentinel/alerts', () => {
  beforeEach(async () => {
    await getSentinelService().reset();
  });

  it('returns the threat score, flagged addresses and incident feed', async () => {
    await raiseCritical({ txHash: 'admin-1' });

    const res = await request(buildApp()).get('/v1/admin/sentinel/alerts');
    expect(res.status).toBe(200);

    expect(res.body.threatScore.score).toBeGreaterThan(0);
    expect(res.body.threatScore.level).not.toBe('NONE');
    expect(res.body.flaggedAddresses[0]).toMatchObject({
      address: ATTACKER,
      highestSeverity: 'CRITICAL',
    });

    expect(res.body.count).toBeGreaterThan(0);
    expect(res.body.incidents[0]).toMatchObject({
      ruleId: 'HIGH_VALUE_DRAIN',
      severity: 'CRITICAL',
      address: ATTACKER,
    });
    expect(res.body.incidents[0].circuitBreaker.action).toBe('set_emergency_pause');
    expect(typeof res.body.generatedAt).toBe('string');
  });

  it('filters by severity and rejects an unknown severity', async () => {
    await raiseCritical({ txHash: 'admin-2' });

    const critical = await request(buildApp()).get(
      '/v1/admin/sentinel/alerts?severity=critical',
    );
    expect(critical.status).toBe(200);
    expect(critical.body.count).toBeGreaterThan(0);

    const low = await request(buildApp()).get('/v1/admin/sentinel/alerts?severity=LOW');
    expect(low.status).toBe(200);
    expect(low.body.count).toBe(0);

    const invalid = await request(buildApp()).get(
      '/v1/admin/sentinel/alerts?severity=BANANA',
    );
    expect(invalid.status).toBe(400);
  });

  it('respects the limit parameter', async () => {
    await raiseCritical({ txHash: 'admin-3', streamId: '1' });
    await raiseCritical({ txHash: 'admin-4', streamId: '2' });

    const res = await request(buildApp()).get('/v1/admin/sentinel/alerts?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.incidents).toHaveLength(1);
  });
});

describe('POST /v1/admin/sentinel/alerts/:id/acknowledge', () => {
  beforeEach(async () => {
    await getSentinelService().reset();
  });

  it('acknowledges a known incident and 404s an unknown one', async () => {
    const [incident] = await raiseCritical({ txHash: 'admin-ack' });
    expect(incident).toBeDefined();

    const ok = await request(buildApp()).post(
      `/v1/admin/sentinel/alerts/${incident!.id}/acknowledge`,
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, acknowledged: true });

    const missing = await request(buildApp()).post(
      '/v1/admin/sentinel/alerts/does-not-exist/acknowledge',
    );
    expect(missing.status).toBe(404);
  });
});
