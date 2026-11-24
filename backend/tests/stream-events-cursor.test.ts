/**
 * Issue #1746: event cursor ordering and invalid cursor recovery.
 *
 * The cursor lives on `GET /v1/streams/:streamId/events`
 * (`src/routes/v1/stream.routes.ts:468` → `getStreamEvents` in
 * `src/controllers/stream.controller.ts:336`), which is where the OpenAPI
 * document declares the `cursor` parameter. `src/routes/v1/events.routes.ts`,
 * named by the issue, paginates by limit/offset and has no cursor at all —
 * verified with `grep -n cursor src/routes/v1/events.routes.ts`, which
 * returns nothing — so there is no cursor contract to test there.
 *
 * These tests pin the cursor contract as it is published and as it behaves:
 * which query the route hands the database, what makes one page follow
 * another, how `hasMore` is decided in cursor mode, and what a cursor the
 * database cannot resolve costs the caller.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mocks = vi.hoisted(() => ({
  prisma: {
    streamEvent: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
  sseService: {
    broadcastToStream: vi.fn(),
    broadcastToUser: vi.fn(),
    addClient: vi.fn(),
    removeClient: vi.fn(),
    getClientCount: vi.fn().mockReturnValue(0),
    getActiveIpCount: vi.fn().mockReturnValue(0),
    getPerIpPeakConnections: vi.fn().mockReturnValue(0),
    getMaxConnections: vi.fn().mockReturnValue(10000),
    checkCapacity: vi.fn().mockReturnValue({ allowed: true }),
    isShuttingDown: vi.fn().mockReturnValue(false),
    initRedisSubscription: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../src/lib/prisma.js', () => ({
  withReplicaFallback: (query: (client: unknown) => unknown) =>
    Promise.resolve(query(mocks.prisma)),
  default: mocks.prisma,
  prisma: mocks.prisma,
}));

vi.mock('../src/services/sse.service.js', () => ({
  sseService: mocks.sseService,
  SSEService: vi.fn(() => mocks.sseService),
}));

vi.mock('../src/lib/redis.js', () => ({
  cache: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    del: vi.fn(),
    getMetadata: vi.fn(),
    getStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, hitRate: 0, itemCount: 0 }),
    cleanup: vi.fn(),
  },
  isRedisAvailable: vi.fn().mockReturnValue(false),
  getPublisher: vi.fn().mockReturnValue(null),
  getSubscriber: vi.fn().mockReturnValue(null),
  connectRedis: vi.fn().mockResolvedValue(undefined),
  disconnectRedis: vi.fn().mockResolvedValue(undefined),
}));

import app from '../src/app.js';

const STREAM = '42';
const PATH = `/v1/streams/${STREAM}/events`;

/**
 * `timestamp` alone is not unique — events written in the same ledger share
 * one — so `id` is the tiebreaker that makes a cursor land in the same place
 * twice. Two rows with one timestamp are the only way to see that.
 */
function event(id: string, timestamp: number) {
  return {
    id,
    streamId: 42n,
    eventType: 'WITHDRAWN',
    amount: '1000',
    transactionHash: `tx-${id}`,
    ledgerSequence: 100,
    timestamp,
    metadata: null,
    createdAt: new Date(timestamp * 1000),
  };
}

const findMany = mocks.prisma.streamEvent.findMany as unknown as ReturnType<typeof vi.fn>;
const count = mocks.prisma.streamEvent.count as unknown as ReturnType<typeof vi.fn>;

/** The one argument a spy received, with a message that names the spy. */
function soleArgument(spy: ReturnType<typeof vi.fn>, name: string): Record<string, unknown> {
  const call = spy.mock.calls[0];
  if (!call) throw new Error(`${name} was never called`);
  return call[0] as Record<string, unknown>;
}

/**
 * The complete failure envelope, for a request that goes through the real
 * express app.
 *
 * `sendApiError` echoes the `X-Request-ID` the request middleware put on the
 * response, so a failure body carries three fields rather than two. The header
 * is pinned non-empty before the comparison, otherwise a build that dropped
 * both the header and the body field would match `undefined` against
 * `undefined` and pass.
 */
function expectErrorEnvelope(
  res: { headers: Record<string, string | string[] | undefined>; body: unknown },
  code: string,
  message: string,
) {
  const requestId = res.headers['x-request-id'];
  expect(typeof requestId).toBe('string');
  expect((requestId as string).length).toBeGreaterThan(0);
  expect(res.body).toEqual({ error: { code, message, requestId } });
}

/**
 * The `findMany` and `count` arguments the route built for this request.
 * Both are asserted per call rather than by a mock matcher so a failure says
 * which query drifted.
 */
async function queryFor(query: string) {
  const res = await request(app).get(`${PATH}${query ? `?${query}` : ''}`).expect(200);
  expect(findMany).toHaveBeenCalledTimes(1);
  expect(count).toHaveBeenCalledTimes(1);
  return {
    body: res.body,
    args: soleArgument(findMany, 'streamEvent.findMany'),
    countArgs: soleArgument(count, 'streamEvent.count'),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  findMany.mockResolvedValue([]);
  count.mockResolvedValue(0);
});

describe('event cursor: what the route asks the database for', () => {
  it('seeks past the cursor row instead of re-reading it', async () => {
    const { args } = await queryFor('cursor=evt-7');

    expect(args.cursor).toEqual({ id: 'evt-7' });
    // skip:1 is what makes the next page start after the cursor rather than
    // on it. Without it the first row of page N+1 repeats the last of page N.
    expect(args.skip).toBe(1);
  });

  it('ignores offset entirely when a cursor is present', async () => {
    const { args } = await queryFor('cursor=evt-7&offset=500');

    expect(args.skip).toBe(1);
    expect(args.skip).not.toBe(500);
  });

  it('pages by offset when no cursor is given', async () => {
    const { args } = await queryFor('limit=2&page=3');

    expect(args).not.toHaveProperty('cursor');
    expect(args.skip).toBe(4);
    expect(args.take).toBe(2);
  });

  it('treats an empty cursor as no cursor', async () => {
    // `?cursor=` arrives as the empty string, which is falsy, so the route
    // must fall back to offset rather than seek to a row called "".
    const { args } = await queryFor('cursor=&offset=10');

    expect(args).not.toHaveProperty('cursor');
    expect(args.skip).toBe(10);
  });

  it('treats a repeated cursor parameter as no cursor', async () => {
    // Express hands an array to a `?cursor=a&cursor=b`; the route only reads
    // a string, so this has to page by offset and not hand Prisma an array.
    const { args } = await queryFor('cursor=a&cursor=b');

    expect(args).not.toHaveProperty('cursor');
    expect(args.skip).toBe(0);
  });

  it('counts the whole stream rather than the cursor window', async () => {
    count.mockResolvedValue(9);
    const { body, countArgs } = await queryFor('cursor=evt-7');

    // The count carries only the filter: no cursor, skip or take. It is the
    // stream's event count, so a client can tell how far into the list a
    // cursor page sits.
    expect(countArgs).toEqual({ where: { streamId: 42n } });
    expect(body.total).toBe(9);
  });
});

describe('event cursor: ordering', () => {
  it('sorts by timestamp with id as the tiebreaker, newest first', async () => {
    const { args } = await queryFor('cursor=evt-7');

    expect(args.orderBy).toEqual([
      { timestamp: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('flips both sort keys for order=asc, so a cursor still lands in the same place', async () => {
    const { args } = await queryFor('cursor=evt-7&order=asc');

    expect(args.orderBy).toEqual([
      { timestamp: 'asc' },
      { id: 'asc' },
    ]);
  });

  it('ignores an order value that is not asc', async () => {
    const { args } = await queryFor('order=ASCENDING');

    expect(args.orderBy).toEqual([
      { timestamp: 'desc' },
      { id: 'desc' },
    ]);
  });

  it('keeps two same-timestamp events in a stable order through the tiebreaker', async () => {
    // The ledger wrote both events in one sequence, so they carry one
    // timestamp. A cursor on the first of them has to resume at the second.
    const ledger = 1_700_000_000;
    findMany.mockResolvedValue([event('evt-b', ledger)]);

    const { body, args } = await queryFor('cursor=evt-a');

    const order = args.orderBy as Array<Record<string, string>>;
    expect(order.map((key) => Object.keys(key))).toEqual([['timestamp'], ['id']]);
    expect(body.data.map((row: { id: string }) => row.id)).toEqual(['evt-b']);
  });
});

describe('event cursor: hasMore is decided by the page, not by the total', () => {
  it('reports more pages when the cursor page came back exactly full', async () => {
    findMany.mockResolvedValue([event('evt-8', 1), event('evt-9', 2)]);
    count.mockResolvedValue(2);

    const { body } = await queryFor('cursor=evt-7&limit=2');

    // A full page says nothing about whether the stream ended exactly there;
    // the route must not claim the list is finished, and must not over-read.
    expect(body.hasMore).toBe(true);
  });

  it('reports the last page when the cursor page came back short', async () => {
    findMany.mockResolvedValue([event('evt-8', 1)]);
    count.mockResolvedValue(9);

    const { body } = await queryFor('cursor=evt-7&limit=2');

    // `total` still says 9, which is exactly why the cursor path cannot use
    // `offset + length < total`: the cursor page has no offset.
    expect(body.hasMore).toBe(false);
  });

  it('reports no more pages for an empty cursor page', async () => {
    const { body } = await queryFor('cursor=evt-last&limit=5');

    expect(body).toEqual({ data: [], total: 0, hasMore: false });
  });

  it('reports a full page of the default size as having more', async () => {
    findMany.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => event(`evt-${i}`, 1_700_000_000 - i)),
    );

    const { args, body } = await queryFor('cursor=evt-50');

    expect(args.take).toBe(50);
    expect(body.hasMore).toBe(true);
  });
});

describe('event cursor: page size boundaries', () => {
  it('clamps a cursor request for more than the published maximum', async () => {
    const { args } = await queryFor('cursor=evt-7&limit=999999');

    expect(args.take).toBe(200);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5'],
    ['not a number', 'ten'],
    ['a float', '1.5'],
    ['padded digits', ' 5'],
  ])('rejects a limit of %s with 400 even alongside a valid cursor', async (_label, limit) => {
    const res = await request(app).get(`${PATH}?cursor=evt-7&limit=${encodeURIComponent(limit)}`);

    expect(res.status).toBe(400);
    expectErrorEnvelope(res, 'INVALID_PAGINATION', 'limit must be a positive integer');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('rejects a malformed cursor page request before reaching the database', async () => {
    const res = await request(app).get(`${PATH}?cursor=evt-7&offset=-1`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAGINATION');
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('event cursor: a cursor the database cannot resolve', () => {
  it('answers 500 for a cursor that names no event', async () => {
    // There is no recovery path: the route passes the raw id to Prisma, and
    // a missing row throws. So a caller who follows a cursor they saved
    // before the events were pruned gets a server error, not an empty page.
    // This test pins that as the current contract; #1746 asks for recovery,
    // which the code does not implement — reported rather than assumed.
    findMany.mockRejectedValue(new Error('Record to update not found.'));

    const res = await request(app).get(`${PATH}?cursor=evt-deleted`);

    expect(res.status).toBe(500);
    expectErrorEnvelope(
      res,
      'INTERNAL_SERVER_ERROR',
      'A technical error occurred. Please try again later.',
    );
  });

  it('answers 500 for a cursor that is not an id at all, rather than 400', async () => {
    findMany.mockRejectedValue(new Error("Invalid `prisma.streamEvent.findMany()` invocation"));

    const res = await request(app).get(`${PATH}?cursor=${encodeURIComponent('not-a-uuid')}`);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('does not retry or silently fall back to the first page', async () => {
    // A client paging with a stale cursor must not be handed page 1 and never
    // learn the difference.
    findMany.mockRejectedValue(new Error('Record to update not found.'));

    await request(app).get(`${PATH}?cursor=evt-gone`).expect(500);

    expect(findMany).toHaveBeenCalledTimes(1);
  });
});

describe('event cursor: what is not a cursor problem', () => {
  it('rejects a stream id that is not a u64 before reading a cursor', async () => {
    const res = await request(app).get('/v1/streams/not-a-number/events?cursor=evt-7');

    expect(res.status).toBe(400);
    expectErrorEnvelope(res, 'INVALID_STREAM_ID', 'Invalid streamId parameter');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('keeps the event type filter applied across a cursor page', async () => {
    const { args } = await queryFor('cursor=evt-7&eventType=WITHDRAWN');

    expect(args.where).toEqual({ streamId: 42n, eventType: 'WITHDRAWN' });
  });

  it('rejects an unknown event type alongside a cursor with 400', async () => {
    const res = await request(app).get(`${PATH}?cursor=evt-7&eventType=NOT_A_THING`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_EVENT_TYPE');
    expect(findMany).not.toHaveBeenCalled();
  });
});
