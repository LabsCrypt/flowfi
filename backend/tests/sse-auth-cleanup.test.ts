import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => ({
  isShuttingDown: vi.fn(),
  checkCapacity: vi.fn(),
  addClient: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock('../src/services/sse.service.js', () => ({
  sseService: {
    isShuttingDown: mocks.isShuttingDown,
    checkCapacity: mocks.checkCapacity,
    addClient: mocks.addClient,
  },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { stream: { findMany: mocks.findMany } },
}));

import { subscribe } from '../src/controllers/sse.controller.js';
import { requestContext } from '../src/logger.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeRes(): Record<string, ReturnType<typeof vi.fn>> & Response {
  const res = {
    statusCode: 0,
    status: vi.fn(),
    json: vi.fn(),
    setHeader: vi.fn().mockReturnThis(),
    writeHead: vi.fn().mockReturnThis(),
    write: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
  };
  res.status = vi.fn().mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn().mockReturnValue(res);
  return res as unknown as Record<string, ReturnType<typeof vi.fn>> & Response;
}

function makeReq(overrides: Record<string, unknown> = {}): Request {
  return {
    headers: {},
    query: {},
    ip: '203.0.113.10',
    socket: { remoteAddress: '203.0.113.10' },
    user: { publicKey: 'GSENDER' },
    ...overrides,
  } as unknown as Request;
}

function allowCapacity(): void {
  mocks.isShuttingDown.mockReturnValue(false);
  mocks.checkCapacity.mockReturnValue({ allowed: true });
}

function ownedStreams() {
  return [
    { streamId: 111n, sender: 'GSENDER', recipient: 'GRECEIVER' },
    { streamId: 222n, sender: 'GCOUNTER', recipient: 'GSENDER' },
  ];
}

function connectedFrame(res: Response): Record<string, unknown> {
  const written = (res.write as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
  return JSON.parse(wired(written));
}

function wired(frame: string): string {
  return frame.replace(/^data: /, '').trim();
}

async function runSubscribe(req: Request, res: Response): Promise<void> {
  await subscribe(req, res);
}

describe('SSE subscribe authorization and rejection paths (#1747)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers 503 before any capacity or database work when shutting down', async () => {
    const res = makeRes();
    mocks.isShuttingDown.mockReturnValue(true);

    await runSubscribe(makeReq(), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Server is shutting down, please reconnect shortly.',
      },
    });
    expect(mocks.checkCapacity).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('answers 429 with Retry-After when the per-IP pool is exhausted', async () => {
    const res = makeRes();
    mocks.isShuttingDown.mockReturnValue(false);
    mocks.checkCapacity.mockReturnValue({
      allowed: false,
      status: 429,
      retryAfterSeconds: 60,
      message: 'Too many SSE connections from this IP. Max 5.',
    });

    await runSubscribe(makeReq(), res);

    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '60');
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'SSE_CONNECTION_REJECTED', message: 'Too many SSE connections from this IP. Max 5.' },
    });
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
    expect(mocks.addClient).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('falls back to 503 and omits Retry-After when the rejection carries no status or hint', async () => {
    const res = makeRes();
    mocks.isShuttingDown.mockReturnValue(false);
    mocks.checkCapacity.mockReturnValue({ allowed: false, message: 'SSE capacity reached.' });

    await runSubscribe(makeReq(), res);

    expect(res.setHeader).not.toHaveBeenCalledWith('Retry-After', expect.anything());
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'SSE_CONNECTION_REJECTED', message: 'SSE capacity reached.' },
    });
  });

  it('honours an explicit 503 rejection without inventing a Retry-After hint', async () => {
    const res = makeRes();
    mocks.isShuttingDown.mockReturnValue(false);
    mocks.checkCapacity.mockReturnValue({ allowed: false, status: 503, message: 'Server is full.' });

    await runSubscribe(makeReq(), res);

    expect(res.setHeader).not.toHaveBeenCalledWith('Retry-After', expect.anything());
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('rejects a request whose authenticated user is missing without opening the stream', async () => {
    const res = makeRes();
    allowCapacity();

    await runSubscribe(makeReq({ user: undefined }), res);

    expect(res.statusCode).toBe(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
    });
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
    expect(mocks.addClient).not.toHaveBeenCalled();
  });

  it('maps a database read failure to 500 before any SSE headers are committed', async () => {
    const res = makeRes();
    allowCapacity();
    mocks.findMany.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

    await runSubscribe(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
    });
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(mocks.addClient).not.toHaveBeenCalled();
  });

  it('rejects a malformed all flag with the validation contract', async () => {
    const res = makeRes();
    allowCapacity();

    await runSubscribe(makeReq({ query: { all: 'sometimes' } }), res);

    expect(res.statusCode).toBe(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'VALIDATION_ERROR',
          message: 'Invalid subscription parameters',
          details: expect.arrayContaining([expect.objectContaining({ code: expect.any(String) })]),
        }),
      }),
    );
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('attributes the capacity check to the resolved client ip and public key', async () => {
    const res = makeRes();
    mocks.isShuttingDown.mockReturnValue(false);
    mocks.checkCapacity.mockReturnValue({ allowed: false, status: 429, retryAfterSeconds: 60, message: 'full' });

    await runSubscribe(makeReq({ headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.99' } }), res);

    expect(mocks.checkCapacity).toHaveBeenCalledWith('198.51.100.7', 'GSENDER');
  });
});

describe('SSE subscribe registration and cleanup handoff (#1747)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowCapacity();
    mocks.findMany.mockResolvedValue(ownedStreams());
  });

  it('registers the very response object it wrote the connected frame to', async () => {
    const res = makeRes();

    await runSubscribe(makeReq(), res);

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    expect(mocks.addClient).toHaveBeenCalledTimes(1);

    const [clientId, registeredRes, subscriptions, sourceIp, publicKey, sandbox] = mocks.addClient.mock.calls[0]!;
    expect(clientId).toMatch(UUID);
    expect(registeredRes).toBe(res);
    expect(subscriptions).toEqual(expect.arrayContaining(['user:GSENDER']));
    expect(sourceIp).toBe('203.0.113.10');
    expect(publicKey).toBe('GSENDER');
    expect(sandbox).toBe(false);
  });

  it('converts bigint stream ids into the string subscription keys the service expects', async () => {
    const res = makeRes();

    await runSubscribe(makeReq(), res);

    const subscriptions = mocks.addClient.mock.calls[0]![2] as string[];
    expect(new Set(subscriptions)).toEqual(new Set(['111', '222', 'user:GSENDER']));
  });

  it('keeps an all-flag subscription scoped to the caller and their own streams', async () => {
    const res = makeRes();

    await runSubscribe(makeReq({ query: { all: true } }), res);

    const subscriptions = mocks.addClient.mock.calls[0]![2] as string[];
    expect(new Set(subscriptions)).toEqual(new Set(['111', '222', 'user:GSENDER']));
  });

  it('drops requested streams the caller does not own', async () => {
    const res = makeRes();

    await runSubscribe(makeReq({ query: { streams: ['999', '111'] } }), res);

    const subscriptions = mocks.addClient.mock.calls[0]![2] as string[];
    expect(new Set(subscriptions)).toEqual(new Set(['111', 'user:GSENDER']));
  });

  it('drops user keys that are not counterparties of the caller', async () => {
    const res = makeRes();

    await runSubscribe(makeReq({ query: { users: ['GRECEIVER', 'GINTRUDER'] } }), res);

    const subscriptions = mocks.addClient.mock.calls[0]![2] as string[];
    expect(subscriptions).toContain('user:GRECEIVER');
    expect(subscriptions).not.toContain('user:GINTRUDER');
  });

  it.each([
    ['the first entry of a proxy chain', { 'x-forwarded-for': '198.51.100.1, 203.0.113.9' }, '198.51.100.1'],
    ['padded proxy entries', { 'x-forwarded-for': ' 198.51.100.2 , 203.0.113.9' }, '198.51.100.2'],
    ['the first entry of an array header', { 'x-forwarded-for': ['198.51.100.3', '203.0.113.9'] }, '198.51.100.3'],
    ['a whitespace-only header', { 'x-forwarded-for': '   ' }, '203.0.113.10'],
    ['an empty array header', { 'x-forwarded-for': [] }, '203.0.113.10'],
  ] as const)('resolves the client ip from %s', async (_label, headers, expected) => {
    const res = makeRes();

    await runSubscribe(makeReq({ headers }), res);

    expect(mocks.checkCapacity).toHaveBeenCalledWith(expected, 'GSENDER');
  });

  it('falls back to the socket address and then to unknown', async () => {
    const socketRes = makeRes();
    await runSubscribe(makeReq({ ip: undefined, socket: { remoteAddress: '198.51.100.4' } }), socketRes);
    expect(mocks.checkCapacity).toHaveBeenLastCalledWith('198.51.100.4', 'GSENDER');

    const unknownRes = makeRes();
    await runSubscribe(makeReq({ ip: undefined, socket: {} }), unknownRes);
    expect(mocks.checkCapacity).toHaveBeenLastCalledWith('unknown', 'GSENDER');
  });

  it('carries the request id and marks sandbox frames in the connected payload', async () => {
    const res = makeRes();

    await requestContext.run({ requestId: 'req-123' }, () => runSubscribe(makeReq({ sandbox: true }), res));

    expect(connectedFrame(res)).toEqual({
      type: 'connected',
      clientId: expect.stringMatching(UUID),
      requestId: 'req-123',
      _sandbox: true,
    });
    expect(mocks.addClient.mock.calls[0]![5]).toBe(true);
  });

  it('omits the sandbox marker for a production frame', async () => {
    const res = makeRes();

    await requestContext.run({ requestId: 'req-456' }, () => runSubscribe(makeReq(), res));

    expect(connectedFrame(res)).toEqual({
      type: 'connected',
      clientId: expect.stringMatching(UUID),
      requestId: 'req-456',
    });
  });

  it('writes the connected frame exactly once', async () => {
    const res = makeRes();

    await runSubscribe(makeReq(), res);

    expect(res.write).toHaveBeenCalledTimes(1);
    expect((res.write as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatch(/^data: \{.*\}\n\n$/);
  });
});
