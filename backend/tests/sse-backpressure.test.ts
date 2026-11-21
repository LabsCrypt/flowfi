/**
 * Issue #1748: SSE backpressure, connection ceilings and dropped-client cleanup.
 *
 * `tests/sse.service.test.ts` already pins the three headline paths (a write
 * that throws, a write that returns false over the buffer ceiling, and the
 * per-user cap reached by `close`). This file covers what that suite leaves
 * open, which is the rest of the documented contract of
 * `src/services/sse.service.ts`:
 *
 *   - what "backpressure" actually costs the client: a slow client is paused
 *     and frames written while it is paused are dropped, because there is no
 *     queue in this service;
 *   - the exact buffer boundary and where the buffer length is read from;
 *   - that one slow client cannot truncate a fan-out to the clients after it;
 *   - that every removal path — drop, close, a failing `end()` — gives the
 *     IP/user slot back, which is what makes `checkCapacity` truthful again;
 *   - the ceiling `MAX_SSE_CONNECTIONS` imposes, and what a bogus value does;
 *   - the Redis pub/sub bridge in `initRedisSubscription`, which no test
 *     exercised at all.
 *
 * `MAX_WRITABLE_BUFFER` is module-private, so it is spelled out here the same
 * way `tests/sse.service.test.ts` does. It is 64 KiB, and the service compares
 * with `>=`, which is why both sides of the boundary are asserted.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { Response } from 'express';
import { EventEmitter } from 'node:events';

const MAX_WRITABLE_BUFFER = 64 * 1024;
const MAX_CONNECTIONS_PER_IP = 5;
const MAX_CONNECTIONS_PER_USER = 10;

vi.mock('../src/lib/redis.js', () => ({
  isRedisAvailable: vi.fn(() => false),
  getPublisher: vi.fn(() => null),
  getSubscriber: vi.fn(() => null),
  cache: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
  connectRedis: vi.fn(),
  disconnectRedis: vi.fn(),
}));

import { SSEService, HEARTBEAT_MESSAGE } from '../src/services/sse.service.js';
import {
  isRedisAvailable,
  getPublisher,
  getSubscriber,
} from '../src/lib/redis.js';

const available = isRedisAvailable as unknown as ReturnType<typeof vi.fn>;
const publisher = getPublisher as unknown as ReturnType<typeof vi.fn>;
const subscriber = getSubscriber as unknown as ReturnType<typeof vi.fn>;

interface MockResponse extends Response {
  emitter: EventEmitter;
  frames: string[];
  setPaused: (value: boolean) => void;
  setBuffer: (value: number) => void;
}

/**
 * `ownWritableLength: false` leaves the property off the response so the
 * service has to fall back to `res.socket.writableLength`, which is the other
 * branch of `getWritableLength`.
 */
function createMockResponse(options: {
  writeReturns?: boolean;
  throwOnWrite?: boolean;
  writableLength?: number;
  ownWritableLength?: boolean;
  writableEnded?: boolean;
  throwOnEnd?: boolean;
} = {}): MockResponse {
  const emitter = new EventEmitter();
  const state = {
    writeReturns: options.writeReturns ?? true,
    writableLength: options.writableLength ?? 0,
    throwOnWrite: options.throwOnWrite ?? false,
  };
  const frames: string[] = [];
  const ownWritableLength = options.ownWritableLength !== false;

  const res = {
    emitter,
    frames,
    setPaused: (value: boolean) => {
      state.writeReturns = !value;
    },
    setBuffer: (value: number) => {
      state.writableLength = value;
    },
    write: vi.fn((frame: string) => {
      if (state.throwOnWrite) throw new Error('write failed');
      frames.push(frame);
      return state.writeReturns;
    }),
    once: emitter.once.bind(emitter),
    on: emitter.on.bind(emitter),
    end: vi.fn(() => {
      if (options.throwOnEnd) throw new Error('end failed');
    }),
    writableEnded: options.writableEnded ?? false,
    socket: { writableLength: state.writableLength },
  };

  if (ownWritableLength) {
    Object.defineProperty(res, 'writableLength', {
      get: () => state.writableLength,
      configurable: true,
    });
  } else {
    // The socket keeps the same live view as the removed response property.
    Object.defineProperty(res.socket, 'writableLength', {
      get: () => state.writableLength,
      configurable: true,
    });
  }

  return res as unknown as MockResponse;
}

let service: SSEService;

afterEach(() => {
  service?.stopHeartbeat();
  delete process.env.MAX_SSE_CONNECTIONS;
  available.mockReturnValue(false);
  publisher.mockReturnValue(null);
  subscriber.mockReturnValue(null);
});

describe('backpressure: a paused client is skipped, not queued', () => {
  beforeEach(() => {
    service = new SSEService();
  });

  it('drops frames written while the client is behind and does not replay them after drain', () => {
    // The issue text calls this a "queue limit". There is no queue: the first
    // `write()` returning false pauses the client and every later frame is
    // discarded until the socket drains. Pinning it here means a future
    // unbounded buffer has to be a deliberate change with a test saying so.
    const res = createMockResponse({ writeReturns: false });
    service.addClient('slow', res);

    service.broadcast('stream.created', { n: 1 });
    expect(res.frames).toEqual(['event: stream.created\ndata: {"n":1}\n\n']);

    service.broadcast('stream.created', { n: 2 });
    service.broadcast('stream.created', { n: 3 });
    expect(res.frames).toHaveLength(1);

    res.emitter.emit('drain');
    service.broadcast('stream.created', { n: 4 });

    // Frame 4 arrives and 2 and 3 never do.
    expect(res.frames).toEqual([
      'event: stream.created\ndata: {"n":1}\n\n',
      'event: stream.created\ndata: {"n":4}\n\n',
    ]);
  });

  it('stops writing the moment the socket backs up and resumes on drain alone', () => {
    const res = createMockResponse({ writeReturns: false });
    service.addClient('slow', res);

    service.broadcast('a', {});
    expect(res.write).toHaveBeenCalledTimes(1);

    // Heartbeats obey the pause too, so a stalled client cannot be used to
    // keep buffering keepalives it will never read.
    service.sendHeartbeat();
    expect(res.write).toHaveBeenCalledTimes(1);

    res.emitter.emit('drain');
    service.sendHeartbeat();
    expect(res.write).toHaveBeenCalledTimes(2);
    expect(res.frames[1]).toBe(HEARTBEAT_MESSAGE);
  });

  it('keeps a client whose buffer is one byte under the ceiling', () => {
    const res = createMockResponse({
      writeReturns: false,
      writableLength: MAX_WRITABLE_BUFFER - 1,
    });
    service.addClient('almost', res);

    service.broadcast('stream.created', {});

    expect(service.getClientCount()).toBe(1);
    expect(service.getSlowClientsDropped()).toBe(0);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('drops a client at the ceiling, where the comparison is inclusive', () => {
    const res = createMockResponse({
      writeReturns: false,
      writableLength: MAX_WRITABLE_BUFFER,
    });
    service.addClient('over', res);

    service.broadcast('stream.created', {});

    expect(service.getClientCount()).toBe(0);
    expect(service.getSlowClientsDropped()).toBe(1);
    expect(res.end).toHaveBeenCalled();
  });

  it('drops a client already paused that keeps buffering on a frame it was skipped for', () => {
    // The pause branch re-checks the buffer, so a client that was fine when it
    // stalled is pruned once its socket has filled up, even though nothing was
    // written to it in between.
    const res = createMockResponse({ writeReturns: false, writableLength: 1024 });
    service.addClient('slow', res);

    service.broadcast('stream.created', {});
    expect(service.getClientCount()).toBe(1);

    res.setBuffer(MAX_WRITABLE_BUFFER);
    service.broadcast('stream.created', {});

    expect(service.getClientCount()).toBe(0);
    expect(service.getSlowClientsDropped()).toBe(1);
  });

  it('reads the buffer off the socket when the response has no writableLength', () => {
    const res = createMockResponse({
      writeReturns: false,
      writableLength: MAX_WRITABLE_BUFFER,
      ownWritableLength: false,
    });
    service.addClient('socket-buffer', res);

    service.broadcast('stream.created', {});

    expect(service.getClientCount()).toBe(0);
  });

  it('treats a response with neither buffer readout as empty rather than throwing', () => {
    const res = createMockResponse({ writeReturns: false });
    delete (res as { writableLength?: unknown }).writableLength;
    delete (res as { socket?: unknown }).socket;
    service.addClient('bare', res);

    expect(() => service.broadcast('stream.created', {})).not.toThrow();
    expect(service.getClientCount()).toBe(1);
  });
});

describe('backpressure: one slow client cannot truncate a fan-out', () => {
  beforeEach(() => {
    service = new SSEService();
  });

  it('reaches the clients after a drop in the same broadcast', () => {
    const first = createMockResponse();
    const slow = createMockResponse({
      writeReturns: false,
      writableLength: MAX_WRITABLE_BUFFER,
    });
    const last = createMockResponse();
    service.addClient('first', first);
    service.addClient('slow', slow);
    service.addClient('last', last);

    service.broadcast('stream.created', { streamId: '1' });

    expect(service.getClientCount()).toBe(2);
    expect(last.frames).toEqual([
      'event: stream.created\ndata: {"streamId":"1"}\n\n',
    ]);
    expect(first.frames).toHaveLength(1);
  });

  it('reaches the clients after a write failure in the same broadcast', () => {
    const broken = createMockResponse({ throwOnWrite: true });
    const last = createMockResponse();
    service.addClient('broken', broken);
    service.addClient('last', last);

    service.broadcast('stream.created', {});

    expect(service.getClientCount()).toBe(1);
    // A failed write is a dead connection, not a slow one: it is removed
    // without being counted as a backpressure drop.
    expect(service.getSlowClientsDropped()).toBe(0);
    expect(last.frames).toHaveLength(1);
  });
});

describe('dropped-client cleanup', () => {
  beforeEach(() => {
    service = new SSEService();
  });

  it('gives the IP slot back when a client is dropped for being slow', () => {
    const ip = '10.0.0.5';
    const clients = Array.from({ length: MAX_CONNECTIONS_PER_IP }, (_, i) =>
      i === 2
        ? createMockResponse({
            writeReturns: false,
            writableLength: MAX_WRITABLE_BUFFER,
          })
        : createMockResponse(),
    );
    clients.forEach((res, i) => service.addClient(`c${i}`, res, [], ip));

    expect(service.checkCapacity(ip).allowed).toBe(false);

    service.broadcast('stream.created', {});

    expect(service.getClientCount()).toBe(MAX_CONNECTIONS_PER_IP - 1);
    expect(service.checkCapacity(ip).allowed).toBe(true);
    // The high-water mark is a metric about the peak, so releasing a slot does
    // not rewind it.
    expect(service.getPerIpPeakConnections()).toBe(MAX_CONNECTIONS_PER_IP);
  });

  it('gives the user slot back when a client is dropped for being slow', () => {
    const userId = 'GUSER789';
    const res = createMockResponse({
      writeReturns: false,
      writableLength: MAX_WRITABLE_BUFFER,
    });
    service.addClient('slow', res, [], '10.0.0.9', userId);
    expect(service.getUserConnectionCount(userId)).toBe(1);

    service.broadcast('stream.created', {});

    expect(service.getUserConnectionCount(userId)).toBe(0);
    expect(service.getActiveUserCount()).toBe(0);
  });

  it('leaves an already-ended response alone during cleanup', () => {
    const res = createMockResponse({ writableEnded: true });
    service.addClient('ended', res, [], '10.0.0.1');

    res.emitter.emit('close');

    expect(service.getClientCount()).toBe(0);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('removes the client even when closing the response throws', () => {
    const broken = createMockResponse({ throwOnEnd: true });
    const healthy = createMockResponse();
    service.addClient('broken', broken, [], '10.0.0.1', 'GBROKEN');
    service.addClient('healthy', healthy, [], '10.0.0.2', 'GHEALTHY');

    expect(() => broken.emitter.emit('close')).not.toThrow();

    expect(service.getClientCount()).toBe(1);
    expect(service.getUserConnectionCount('GBROKEN')).toBe(0);
    expect(service.checkCapacity('10.0.0.1').allowed).toBe(true);

    // And the service is still usable afterwards.
    service.broadcast('stream.created', {});
    expect(healthy.frames).toHaveLength(1);
  });

  it('is idempotent when a client closes twice', () => {
    const res = createMockResponse();
    service.addClient('dup', res, [], '10.0.0.7', 'GDUP');

    res.emitter.emit('close');
    res.emitter.emit('close');

    expect(service.getClientCount()).toBe(0);
    expect(service.getActiveIpCount()).toBe(0);
    expect(service.getUserConnectionCount('GDUP')).toBe(0);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('stops the heartbeat once the last client is dropped for being slow', () => {
    const res = createMockResponse({
      writeReturns: false,
      writableLength: MAX_WRITABLE_BUFFER,
    });
    service.addClient('slow', res);
    expect(service.isHeartbeatRunning()).toBe(true);

    service.broadcast('stream.created', {});

    expect(service.getClientCount()).toBe(0);
    expect(service.isHeartbeatRunning()).toBe(false);
  });
});

describe('connection ceiling', () => {
  afterEach(() => {
    delete process.env.MAX_SSE_CONNECTIONS;
  });

  it('rejects at MAX_SSE_CONNECTIONS with 503 and no Retry-After hint', () => {
    process.env.MAX_SSE_CONNECTIONS = '3';
    service = new SSEService();
    expect(service.getMaxConnections()).toBe(3);

    for (let i = 0; i < 3; i += 1) {
      expect(service.checkCapacity(`10.9.0.${i}`).allowed).toBe(true);
      service.addClient(`c${i}`, createMockResponse(), [], `10.9.0.${i}`);
    }

    const rejected = service.checkCapacity('10.9.9.9');
    expect(rejected).toEqual({
      allowed: false,
      status: 503,
      message: 'SSE capacity reached. Please try again shortly.',
    });
    // A saturated server cannot promise the caller will fit in 60s, so it must
    // not send a hint that a `429` would carry.
    expect(rejected.retryAfterSeconds).toBeUndefined();
  });

  it('reports saturation ahead of the per-IP limit it also exceeds', () => {
    process.env.MAX_SSE_CONNECTIONS = '2';
    service = new SSEService();
    service.addClient('c0', createMockResponse(), [], '10.10.0.1');
    service.addClient('c1', createMockResponse(), [], '10.10.0.1');

    const rejected = service.checkCapacity('10.10.0.1');

    // Both limits are breached by this one IP; the answer has to be the one
    // that tells the caller to back off rather than to close a tab.
    expect(rejected.status).toBe(503);
  });

  it('falls back to the built-in ceiling for a value that is not a usable count', () => {
    for (const raw of ['0', '-4', 'abc', '', '  ', 'Infinity']) {
      process.env.MAX_SSE_CONNECTIONS = raw;
      service = new SSEService();
      expect(service.getMaxConnections()).toBe(10000);
      service.stopHeartbeat();
    }

    // A fractional ceiling is truncated, not rejected, and still honored.
    process.env.MAX_SSE_CONNECTIONS = '1.9';
    service = new SSEService();
    expect(service.getMaxConnections()).toBe(1);
    service.addClient('c0', createMockResponse(), [], '10.11.0.1');
    expect(service.checkCapacity('10.11.0.2').allowed).toBe(false);
  });

  it('quotes the per-IP limit and a 60s retry window in the rejection', () => {
    service = new SSEService();
    const ip = '10.12.0.1';
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i += 1) {
      service.addClient(`c${i}`, createMockResponse(), [], ip);
    }

    const rejected = service.checkCapacity(ip);

    expect(rejected).toMatchObject({
      allowed: false,
      status: 429,
      retryAfterSeconds: 60,
    });
    expect(rejected.message).toBe(
      `Too many SSE connections from this IP. Max ${MAX_CONNECTIONS_PER_IP}.`,
    );
  });

  it('counts a user against the per-user ceiling across every IP it uses', () => {
    service = new SSEService();
    const userId = 'GFARM';
    for (let i = 0; i < MAX_CONNECTIONS_PER_USER; i += 1) {
      service.addClient(`c${i}`, createMockResponse(), [], `10.13.${i}.1`, userId);
    }

    expect(service.getActiveIpCount()).toBe(MAX_CONNECTIONS_PER_USER);
    const rejected = service.checkCapacity('10.13.99.1', userId);

    expect(rejected.status).toBe(429);
    expect(rejected.retryAfterSeconds).toBe(60);
    expect(rejected.message).toBe(
      `Too many concurrent SSE connections for this user. Max ${MAX_CONNECTIONS_PER_USER}.`,
    );
    expect(service.getPerUserPeakConnections()).toBe(MAX_CONNECTIONS_PER_USER);
  });

  it('applies the per-IP ceiling per address instead of globally', () => {
    service = new SSEService();
    for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i += 1) {
      service.addClient(`a${i}`, createMockResponse(), [], '10.14.0.1');
    }

    expect(service.checkCapacity('10.14.0.1').allowed).toBe(false);
    expect(service.checkCapacity('10.14.0.2').allowed).toBe(true);
    expect(service.getActiveIpCount()).toBe(1);
  });
});

describe('shutdown fan-out', () => {
  beforeEach(() => {
    service = new SSEService();
  });

  it('tells every client to reconnect and survives a client whose socket is already gone', () => {
    const broken = createMockResponse({ throwOnWrite: true });
    const healthy = createMockResponse();
    service.addClient('broken', broken);
    service.addClient('healthy', healthy);

    service.sendReconnectToAll();

    expect(service.isShuttingDown()).toBe(true);
    expect(healthy.frames).toEqual(['event: reconnect\ndata: {}\n\n']);
    // The broken client is not removed here: shutdown only announces, and the
    // peer's own close event does the cleanup.
    expect(service.getClientCount()).toBe(2);
  });

  it('tells the clients it is shutting down before the last frame goes out', () => {
    const res = createMockResponse();
    service.addClient('client', res);

    expect(service.isShuttingDown()).toBe(false);
    service.sendReconnectToAll();

    expect(service.isShuttingDown()).toBe(true);
    expect(service.isHeartbeatRunning()).toBe(false);
  });
});

describe('redis pub/sub bridge', () => {
  beforeEach(() => {
    service = new SSEService();
  });

  it('publishes stream events instead of writing locally when redis is up', () => {
    // Without this, a two-process deployment would silently stop delivering
    // events to the process that does not hold the client.
    const publish = vi.fn();
    available.mockReturnValue(true);
    publisher.mockReturnValue({ publish });
    const local = createMockResponse();
    service.addClient('local', local, ['7']);

    service.broadcastToStream('7', 'stream.topped_up', { amount: '10' });

    expect(publish).toHaveBeenCalledWith(
      'sse:stream:7',
      JSON.stringify({ event: 'stream.topped_up', data: { amount: '10' } }),
    );
    expect(local.write).not.toHaveBeenCalled();
  });

  it('publishes user events on the user channel', () => {
    const publish = vi.fn();
    available.mockReturnValue(true);
    publisher.mockReturnValue({ publish });

    service.broadcastToUser('GPUB123', 'stream.completed', { streamId: '7' });

    expect(publish).toHaveBeenCalledWith(
      'sse:user:GPUB123',
      JSON.stringify({ event: 'stream.completed', data: { streamId: '7' } }),
    );
  });

  it('delivers a redis message to the subscribed clients when the bridge reads it back', async () => {
    const handlers = new Map<string, (...args: never[]) => void>();
    subscriber.mockReturnValue({
      psubscribe: vi.fn(),
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers.set(event, handler);
      }),
    });

    await service.initRedisSubscription();

    const mine = createMockResponse();
    const theirs = createMockResponse();
    const watching = createMockResponse();
    service.addClient('mine', mine, ['7']);
    service.addClient('theirs', theirs, ['8']);
    service.addClient('watching', watching, ['*']);

    handlers.get('pmessage')!(
      'sse:stream:*' as never,
      'sse:stream:7' as never,
      JSON.stringify({ event: 'stream.cancelled', data: { streamId: '7' } }) as never,
    );

    expect(mine.frames).toEqual([
      'event: stream.cancelled\ndata: {"streamId":"7"}\n\n',
    ]);
    expect(watching.frames).toHaveLength(1);
    expect(theirs.write).not.toHaveBeenCalled();
  });

  it('ignores a malformed redis payload instead of failing the subscription', async () => {
    const handlers = new Map<string, (...args: never[]) => void>();
    subscriber.mockReturnValue({
      psubscribe: vi.fn(),
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        handlers.set(event, handler);
      }),
    });
    await service.initRedisSubscription();

    const res = createMockResponse();
    service.addClient('client', res, ['*']);

    const deliver = () =>
      handlers.get('pmessage')!(
        'sse:stream:*' as never,
        'sse:stream:7' as never,
        '{not json' as never,
      );

    expect(deliver).not.toThrow();
    expect(res.write).not.toHaveBeenCalled();
    expect(service.getClientCount()).toBe(1);
  });

  it('does nothing without a subscriber, so a redis-less boot is not an error', async () => {
    subscriber.mockReturnValue(null);

    await expect(service.initRedisSubscription()).resolves.toBeUndefined();
  });
});
