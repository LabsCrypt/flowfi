/**
 * Issue #824 — audit trail for privileged actions.
 *
 * A successful admin reset or replay destroys server state, and successful
 * logins hand out tokens. None of that left a record of *who* did it: the
 * handlers only logged failures. These tests pin the trail end to end through
 * the real app (real auth middleware, real logger) with the destructive
 * services mocked, so what is asserted is the shipped wiring rather than a
 * helper called in isolation.
 *
 * `src/logger.ts` writes metadata verbatim — `logger-redaction-contract.test.ts`
 * pins that today — so "no secrets in audit entries" is enforced where the
 * entry is built. The last block asserts that construction directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import * as StellarSdk from '@stellar/stellar-sdk';
import Transport from 'winston-transport';

const mocks = vi.hoisted(() => {
  return {
    sseService: {
      broadcastToStream: vi.fn(),
      broadcastToUser: vi.fn(),
      addClient: vi.fn(),
      removeClient: vi.fn(),
      getClientCount: vi.fn().mockReturnValue(0),
      getActiveIpCount: vi.fn().mockReturnValue(1),
      getPerIpPeakConnections: vi.fn().mockReturnValue(1),
      getMaxConnections: vi.fn().mockReturnValue(10000),
      checkCapacity: vi.fn().mockReturnValue({ allowed: true }),
      isShuttingDown: vi.fn().mockReturnValue(false),
      initRedisSubscription: vi.fn().mockResolvedValue(undefined),
    },
    cache: {
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      del: vi.fn(),
      getMetadata: vi.fn(),
      getStats: vi.fn().mockReturnValue({
        hits: 0,
        misses: 0,
        hitRate: 0,
        itemCount: 0,
      }),
      cleanup: vi.fn(),
    },
    prisma: {
      stream: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      streamEvent: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
      indexerState: { findUnique: vi.fn().mockResolvedValue(null) },
      $queryRaw: vi.fn().mockResolvedValue([]),
      $disconnect: vi.fn().mockResolvedValue(undefined),
    },
    pool: { totalCount: 0, idleCount: 0, waitingCount: 0 },
  };
});

vi.mock('../src/services/sse.service.js', () => ({
  sseService: mocks.sseService,
  SSEService: vi.fn(() => mocks.sseService),
}));

vi.mock('../src/lib/redis.js', () => ({
  cache: mocks.cache,
  isRedisAvailable: vi.fn().mockReturnValue(false),
  getPublisher: vi.fn().mockReturnValue(null),
  getSubscriber: vi.fn().mockReturnValue(null),
  connectRedis: vi.fn().mockResolvedValue(undefined),
  disconnectRedis: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/lib/prisma.js', () => ({
  default: mocks.prisma,
  prisma: mocks.prisma,
  pool: mocks.pool,
}));

vi.mock('../src/services/indexerService.js', () => ({
  getIndexerStatus: vi.fn().mockResolvedValue({}),
  resetIndexer: vi.fn().mockResolvedValue(undefined),
  replayFromLedger: vi.fn().mockResolvedValue('replay-request-1'),
  previewReset: vi.fn().mockResolvedValue({}),
  previewReplay: vi.fn().mockResolvedValue({}),
}));

vi.mock('../src/workers/soroban-event-worker.js', () => ({
  sorobanEventWorker: {
    getEventCounters: vi.fn().mockReturnValue({
      eventsProcessed: 0,
      eventsFailed: 0,
      lastErrorAt: null,
      degraded: false,
    }),
    runExclusive: vi.fn((fn: () => unknown) => fn()),
  },
  SorobanEventWorker: vi.fn(),
}));

import app from '../src/app.js';
import logger, { auditLog } from '../src/logger.js';
import { signJwt, __authChallengeTestUtils } from '../src/middleware/auth.js';
import { resetIndexer, replayFromLedger } from '../src/services/indexerService.js';

// ─── Capture seam ─────────────────────────────────────────────────────────────

type LogLine = Record<string, any> & {
  audit?: { action: string; actor: string; params: Record<string, unknown> };
};

/**
 * A transport attached to the real logger. Winston runs the logger's own
 * format pipeline (timestamp, requestId injection, JSON) before handing the
 * record to every transport, so `requestId` here is the value the console
 * transport would write — not something this test added.
 */
class CaptureTransport extends Transport {
  lines: LogLine[] = [];

  log(info: LogLine, next: () => void): void {
    this.lines.push(info);
    next();
  }

  audits(): NonNullable<LogLine['audit']>[] {
    return this.lines.flatMap((line) => (line.audit ? [line.audit] : []));
  }

  lineFor(action: string): LogLine {
    const line = this.lines.find((candidate) => candidate.audit?.action === action);
    expect(line, `no log line carried audit action "${action}"`).toBeDefined();
    return line!;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ADMIN_PUBLIC_KEY = 'GADMIN12345678901234567890123456789012345678901234567890';
const NON_ADMIN_PUBLIC_KEY = 'GUSER12345678901234567890123456789012345678901234567890';

function createToken(publicKey: string = ADMIN_PUBLIC_KEY): string {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    sub: publicKey,
    iat: now,
    exp: now + 3600,
    iss: 'flowfi-api',
    aud: 'flowfi-api',
  });
}

function buildSignedTransaction(keypair: StellarSdk.Keypair, nonce: string): string {
  const account = new StellarSdk.Account(keypair.publicKey(), '0');
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(
      StellarSdk.Operation.manageData({ name: 'auth', value: Buffer.from(nonce, 'hex') }),
    )
    .setTimeout(60)
    .build();
  tx.sign(keypair);
  return tx.toXDR();
}

let capture: CaptureTransport;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ADMIN_PUBLIC_KEY = ADMIN_PUBLIC_KEY;
  __authChallengeTestUtils.challenges.clear();
  capture = new CaptureTransport({ level: 'debug' });
  logger.add(capture);
});

afterEach(() => {
  logger.remove(capture);
});

// ─── Destructive admin actions ────────────────────────────────────────────────

describe('admin audit entries (#824)', () => {
  it('records who reset the indexer, with the ledger and the request id', async () => {
    const res = await request(app)
      .post('/v1/admin/indexer/reset')
      .set('Authorization', `Bearer ${createToken()}`)
      .set('X-Request-ID', 'audit-reset-1')
      .send({ ledger: 42 });

    expect(res.status).toBe(200);
    expect(resetIndexer).toHaveBeenCalledWith(42);

    const line = capture.lineFor('indexer.reset');
    expect(line.message).toBe('audit: indexer.reset');
    expect(line.audit).toEqual({
      action: 'indexer.reset',
      actor: ADMIN_PUBLIC_KEY,
      params: { ledger: 42 },
    });
    expect(line.requestId).toBe('audit-reset-1');
  });

  it('records who replayed the indexer, with both ledger and replay request id', async () => {
    vi.mocked(replayFromLedger).mockResolvedValueOnce('replay-9f2');

    const res = await request(app)
      .post('/v1/admin/indexer/replay')
      .query({ from_ledger: 7 })
      .set('Authorization', `Bearer ${createToken()}`)
      .set('X-Request-ID', 'audit-replay-1');

    expect(res.status).toBe(202);
    expect(res.body.requestId).toBe('replay-9f2');

    const line = capture.lineFor('indexer.replay');
    expect(line.audit).toEqual({
      action: 'indexer.replay',
      actor: ADMIN_PUBLIC_KEY,
      params: { fromLedger: 7, replayRequestId: 'replay-9f2' },
    });
    expect(line.requestId).toBe('audit-replay-1');
    // The replay's own request id lives inside `params`; the HTTP request id
    // lives on the record. `auditSafe` keeps them from being confused.
    expect(line.audit?.params).not.toHaveProperty('requestId');
  });

  it('mints a request id when the caller sends none, and records that one', async () => {
    const res = await request(app)
      .post('/v1/admin/indexer/reset')
      .set('Authorization', `Bearer ${createToken()}`)
      .send({ ledger: 9 });

    expect(res.status).toBe(200);
    const line = capture.lineFor('indexer.reset');
    expect(typeof line.requestId).toBe('string');
    expect(line.requestId).toBe(res.headers['x-request-id']);
  });

  it('does not audit a dry-run preview, because nothing was destroyed', async () => {
    const res = await request(app)
      .post('/v1/admin/indexer/reset')
      .query({ dryRun: 'true' })
      .set('Authorization', `Bearer ${createToken()}`)
      .send({ ledger: 42 });

    expect(res.status).toBe(200);
    expect(capture.audits().map((entry) => entry.action)).not.toContain('indexer.reset');
  });
});

// ─── Auth and admin access ────────────────────────────────────────────────────

describe('auth and admin-access audit entries (#824)', () => {
  it('records a successful wallet login with the publicKey and no token', async () => {
    const keypair = StellarSdk.Keypair.random();
    const challengeRes = await request(app)
      .post('/v1/auth/challenge')
      .send({ publicKey: keypair.publicKey() });
    const signedTransaction = buildSignedTransaction(keypair, challengeRes.body.nonce);

    const res = await request(app)
      .post('/v1/auth/verify')
      .set('X-Request-ID', 'audit-verify-1')
      .send({ publicKey: keypair.publicKey(), signedTransaction });

    expect(res.status).toBe(200);

    const line = capture.lineFor('auth.verify');
    expect(line.audit).toEqual({
      action: 'auth.verify',
      actor: keypair.publicKey(),
      params: {},
    });
    expect(line.requestId).toBe('audit-verify-1');

    const auditText = JSON.stringify(capture.audits());
    expect(auditText).not.toContain(res.body.token);
    expect(auditText).not.toContain(signedTransaction);
  });

  it('records an admin grant and a deny, each with the caller publicKey', async () => {
    const denied = await request(app)
      .get('/v1/events/stats')
      .set('Authorization', `Bearer ${createToken(NON_ADMIN_PUBLIC_KEY)}`)
      .set('X-Request-ID', 'audit-deny-1');
    expect(denied.status).toBe(403);

    const deniedLine = capture.lineFor('admin.access_denied');
    expect(deniedLine.audit).toEqual({
      action: 'admin.access_denied',
      actor: NON_ADMIN_PUBLIC_KEY,
      params: { reason: 'not_admin' },
    });
    expect(deniedLine.requestId).toBe('audit-deny-1');

    const granted = await request(app)
      .get('/v1/events/stats')
      .set('Authorization', `Bearer ${createToken()}`);
    expect(granted.status).toBe(200);

    const grantedLine = capture.lineFor('admin.access_granted');
    expect(grantedLine.audit).toEqual({
      action: 'admin.access_granted',
      actor: ADMIN_PUBLIC_KEY,
      params: {},
    });
  });

  it('distinguishes a deny caused by an unset ADMIN_PUBLIC_KEY', async () => {
    delete process.env.ADMIN_PUBLIC_KEY;

    const res = await request(app)
      .get('/v1/events/stats')
      .set('Authorization', `Bearer ${createToken()}`);
    expect(res.status).toBe(403);

    expect(capture.lineFor('admin.access_denied').audit?.params).toEqual({
      reason: 'admin_key_unset',
    });
  });
});

// ─── Secret-free by construction ─────────────────────────────────────────────

describe('audit entries cannot carry secrets (#824)', () => {
  it('drops secret-shaped keys and non-primitive values, keeping the rest', () => {
    auditLog('probe.credentials', 'GACTOR', {
      ledger: 5,
      note: 'kept',
      amount: 12n,
      password: 'hunter2',
      passphrase: 'hunter2',
      secret: 'hunter2',
      token: 'hunter2',
      authorization: 'Bearer hunter2',
      credential: 'hunter2',
      privateKey: 'hunter2',
      seed: 'hunter2',
      signature: 'hunter2',
      apiKey: 'hunter2',
      api_key: 'hunter2',
      mnemonic: 'hunter2',
      nested: { anything: true },
    });

    const line = capture.lineFor('probe.credentials');
    expect(line.audit?.params).toEqual({ ledger: 5, note: 'kept', amount: '12' });
    expect(JSON.stringify(line)).not.toContain('hunter2');
  });
});
