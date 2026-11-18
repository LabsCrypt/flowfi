import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

const WALLET = 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA';

const { mockPrisma, listEventsForWalletMock } = vi.hoisted(() => ({
  mockPrisma: {
    stream: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
    },
    streamEvent: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1n }]),
    $disconnect: vi.fn(),
  },
  listEventsForWalletMock: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  default: mockPrisma,
  prisma: mockPrisma,
  withReplicaFallback: (fn: (client: unknown) => unknown) => fn(mockPrisma),
}));

vi.mock('../src/repositories/streamEvent.repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/repositories/streamEvent.repository.js')>();
  return {
    ...actual,
    listEventsForWallet: listEventsForWalletMock,
  };
});

vi.mock('../src/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/middleware/auth.js')>();
  return {
    ...actual,
    requireAuth: vi.fn((req: any, _res: any, next: any) => {
      req.user = { publicKey: WALLET };
      next();
    }),
  };
});

import app from '../src/app.js';

const walletEvent = (overrides: Record<string, unknown> = {}) => ({
  id: 'e1',
  streamId: 1,
  eventType: 'TOPPED_UP',
  amount: null,
  transactionHash: 'tx-hash',
  ledgerSequence: 1,
  timestamp: 1700000000,
  metadata: JSON.stringify({ newDepositedAmount: '5' }),
  createdAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('Sandbox mode event tagging (issue #1535)', () => {
  const original = process.env.SANDBOX_MODE_ENABLED;

  beforeEach(() => {
    vi.clearAllMocks();
    listEventsForWalletMock.mockResolvedValue({
      events: [walletEvent()],
      total: 1,
      limit: 50,
      offset: 0,
      hasMore: false,
    });
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.SANDBOX_MODE_ENABLED;
    } else {
      process.env.SANDBOX_MODE_ENABLED = original;
    }
  });

  it('tags events with _sandbox and sets sandbox headers for a sandboxed request', async () => {
    process.env.SANDBOX_MODE_ENABLED = 'true';

    const res = await request(app)
      .get('/v1/events')
      .query({ address: WALLET, sandbox: 'true' });

    expect(res.status).toBe(200);
    expect(res.headers['x-sandbox-mode']).toBe('true');
    expect(res.headers['x-environment']).toBe('sandbox');

    const metadata = JSON.parse(res.body.events[0].metadata);
    expect(metadata._sandbox).toBe(true);
    // Existing metadata fields must be preserved alongside the tag.
    expect(metadata.newDepositedAmount).toBe('5');
  });

  it('does not tag events for a non-sandbox request', async () => {
    process.env.SANDBOX_MODE_ENABLED = 'true';

    const res = await request(app)
      .get('/v1/events')
      .query({ address: WALLET });

    expect(res.status).toBe(200);
    expect(res.headers['x-environment']).toBe('production');
    expect(res.headers['x-sandbox-mode']).toBeUndefined();

    const metadata = JSON.parse(res.body.events[0].metadata);
    expect(metadata._sandbox).toBeUndefined();
  });

  it('ignores a sandbox request when sandbox mode is globally disabled', async () => {
    process.env.SANDBOX_MODE_ENABLED = 'false';

    const res = await request(app)
      .get('/v1/events')
      .query({ address: WALLET, sandbox: 'true' });

    expect(res.status).toBe(200);
    expect(res.headers['x-sandbox-mode']).toBeUndefined();

    const metadata = JSON.parse(res.body.events[0].metadata);
    expect(metadata._sandbox).toBeUndefined();
  });

  it('still tags sandbox events when stored metadata is malformed (never throws)', async () => {
    process.env.SANDBOX_MODE_ENABLED = 'true';
    listEventsForWalletMock.mockResolvedValueOnce({
      events: [walletEvent({ id: 'e2', eventType: 'ADMIN_TRANSFERRED', metadata: '{not valid json' })],
      total: 1,
      limit: 50,
      offset: 0,
      hasMore: false,
    });

    const res = await request(app)
      .get('/v1/events')
      .query({ address: WALLET, sandbox: 'true' });

    expect(res.status).toBe(200);
    const metadata = JSON.parse(res.body.events[0].metadata);
    expect(metadata._sandbox).toBe(true);
  });
});
