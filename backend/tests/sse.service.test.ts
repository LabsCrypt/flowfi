import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Response } from 'express';
import { EventEmitter } from 'node:events';
import { SSEService } from '../src/services/sse.service.js';

const MAX_WRITABLE_BUFFER = 64 * 1024;

function createMockResponse(options: {
  writeReturns?: boolean;
  throwOnWrite?: boolean;
  writableLength?: number;
} = {}): Response & { emitter: EventEmitter } {
  const emitter = new EventEmitter();
  const socket = {
    writableLength: options.writableLength ?? 0,
  };

  const res = {
    emitter,
    write: vi.fn(() => {
      if (options.throwOnWrite) {
        throw new Error('write failed');
      }
      return options.writeReturns ?? true;
    }),
    once: emitter.once.bind(emitter),
    on: emitter.on.bind(emitter),
    end: vi.fn(),
    writableEnded: false,
    socket,
  };

  Object.defineProperty(res, 'writableLength', {
    get: () => options.writableLength ?? 0,
    configurable: true,
  });

  return res as unknown as Response & { emitter: EventEmitter };
}

describe('SSEService backpressure', () => {
  let service: SSEService;

  afterEach(() => {
    service.stopHeartbeat();
  });

  it('removes a client when write() throws without blocking other clients', () => {
    service = new SSEService();

    const failingRes = createMockResponse({ throwOnWrite: true });
    const healthyRes = createMockResponse();

    service.addClient('failing-client', failingRes);
    service.addClient('healthy-client', healthyRes);

    expect(service.getClientCount()).toBe(2);

    service.broadcast('stream.created', { streamId: 1 });

    expect(service.getClientCount()).toBe(1);
    expect(failingRes.end).toHaveBeenCalled();
    expect(healthyRes.write).toHaveBeenCalled();
  });

  it('drops a slow client when write() returns false and buffer exceeds threshold', () => {
    service = new SSEService();

    const slowRes = createMockResponse({
      writeReturns: false,
      writableLength: MAX_WRITABLE_BUFFER,
    });
    const healthyRes = createMockResponse();

    service.addClient('slow-client', slowRes);
    service.addClient('healthy-client', healthyRes);

    service.broadcast('stream.created', { streamId: 1 });

    expect(service.getClientCount()).toBe(1);
    expect(service.getSlowClientsDropped()).toBe(1);
    expect(slowRes.end).toHaveBeenCalled();
    expect(healthyRes.write).toHaveBeenCalled();
  });

  it('removes slow clients from heartbeat broadcasts as well', () => {
    service = new SSEService();

    const slowRes = createMockResponse({
      writeReturns: false,
      writableLength: MAX_WRITABLE_BUFFER,
    });

    service.addClient('slow-client', slowRes);
    service.sendHeartbeat();

    expect(service.getClientCount()).toBe(0);
    expect(service.getSlowClientsDropped()).toBe(1);
  });
});

describe('SSEService per-user connection cap', () => {
  let service: SSEService;

  afterEach(() => {
    service.stopHeartbeat();
  });

  it('allows connections from a user up to the per-user cap, independent of IP', () => {
    service = new SSEService();
    const userId = 'GUSER123';

    // Spread the connections across different IPs so only the per-user cap
    // (not the pre-existing per-IP cap) is exercised here.
    for (let i = 0; i < 10; i += 1) {
      const capacity = service.checkCapacity(`10.0.0.${i}`, userId);
      expect(capacity.allowed).toBe(true);
      service.addClient(`client-${i}`, createMockResponse(), [], `10.0.0.${i}`, userId);
    }

    expect(service.getUserConnectionCount(userId)).toBe(10);

    // The 11th connection for the same user, from yet another IP, must be rejected.
    const rejected = service.checkCapacity('10.0.0.99', userId);
    expect(rejected.allowed).toBe(false);
    expect(rejected.status).toBe(429);
    expect(rejected.message).toMatch(/user/i);
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('does not cap unauthenticated/anonymous checks that omit a userId', () => {
    service = new SSEService();

    for (let i = 0; i < 10; i += 1) {
      const capacity = service.checkCapacity(`10.1.0.${i}`);
      expect(capacity.allowed).toBe(true);
    }
  });

  it('releases the per-user slot once a client disconnects', () => {
    service = new SSEService();
    const userId = 'GUSER456';

    const res = createMockResponse();
    service.addClient('client-a', res, [], '10.2.0.1', userId);
    expect(service.getUserConnectionCount(userId)).toBe(1);

    res.emitter.emit('close');

    expect(service.getUserConnectionCount(userId)).toBe(0);
  });
});
