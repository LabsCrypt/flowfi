import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { Response } from 'express';
import { EventEmitter } from 'node:events';
import {
  SSEService,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MESSAGE,
} from '../src/services/sse.service.js';

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

describe('SSEService sandbox event tagging (#1535)', () => {
  let service: SSEService;

  afterEach(() => {
    service.stopHeartbeat();
  });

  it('tags events with _sandbox for sandbox clients but not production clients', () => {
    service = new SSEService();

    const sandboxRes = createMockResponse();
    const productionRes = createMockResponse();

    service.addClient('sandbox-client', sandboxRes, ['1'], '10.0.0.1', undefined, true);
    service.addClient('production-client', productionRes, ['1'], '10.0.0.2', undefined, false);

    service.broadcast('stream.topped_up', { streamId: '1', amount: '100' });

    const sandboxMessage = vi.mocked(sandboxRes.write).mock.calls[0]?.[0] as string;
    const productionMessage = vi.mocked(productionRes.write).mock.calls[0]?.[0] as string;

    expect(sandboxMessage).toContain('"_sandbox":true');
    expect(sandboxMessage).toContain('"streamId":"1"');
    expect(productionMessage).not.toContain('_sandbox');
    expect(productionMessage).toContain('"streamId":"1"');
  });

  it('defaults new clients to production (untagged) when sandbox is not specified', () => {
    service = new SSEService();

    const res = createMockResponse();
    service.addClient('default-client', res, ['1'], '10.0.0.3');

    service.broadcast('stream.created', { streamId: '1' });

    const message = vi.mocked(res.write).mock.calls[0]?.[0] as string;
    expect(message).not.toContain('_sandbox');
  });
});

describe('SSEService keepalive heartbeat', () => {
  let service: SSEService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new SSEService();
  });

  afterEach(() => {
    service.stopHeartbeat();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses a 25s interval and an SSE comment frame', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(25_000);
    expect(HEARTBEAT_MESSAGE).toBe(': keepalive\n\n');
  });

  it('writes a keepalive comment to every connected client every 25 seconds', () => {
    const resA = createMockResponse();
    const resB = createMockResponse();
    service.addClient('client-a', resA);
    service.addClient('client-b', resB);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS - 1);
    expect(resA.write).not.toHaveBeenCalled();
    expect(resB.write).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(resA.write).toHaveBeenCalledTimes(1);
    expect(resA.write).toHaveBeenLastCalledWith(': keepalive\n\n');
    expect(resB.write).toHaveBeenCalledTimes(1);
    expect(resB.write).toHaveBeenLastCalledWith(': keepalive\n\n');

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    expect(resA.write).toHaveBeenCalledTimes(3);
    expect(resB.write).toHaveBeenCalledTimes(3);
  });

  it('prunes clients whose heartbeat write fails and keeps the rest alive', () => {
    const brokenRes = createMockResponse({ throwOnWrite: true });
    const healthyRes = createMockResponse();
    service.addClient('broken-client', brokenRes);
    service.addClient('healthy-client', healthyRes);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    expect(service.getClientCount()).toBe(1);
    expect(brokenRes.end).toHaveBeenCalled();
    expect(service.isHeartbeatRunning()).toBe(true);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(brokenRes.write).toHaveBeenCalledTimes(1);
    expect(healthyRes.write).toHaveBeenCalledTimes(2);
  });

  it('stops the timer when the last client disconnects and restarts on reconnect', () => {
    const res = createMockResponse();
    service.addClient('client-a', res);
    expect(service.isHeartbeatRunning()).toBe(true);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    res.emitter.emit('close');

    expect(service.isHeartbeatRunning()).toBe(false);
    expect(clearSpy).toHaveBeenCalledTimes(1);

    const next = createMockResponse();
    service.addClient('client-b', next);
    expect(service.isHeartbeatRunning()).toBe(true);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(next.write).toHaveBeenCalledWith(': keepalive\n\n');
  });

  it('stops the timer when the only client is pruned by a failed heartbeat', () => {
    service.addClient('broken-client', createMockResponse({ throwOnWrite: true }));
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    expect(service.getClientCount()).toBe(0);
    expect(service.isHeartbeatRunning()).toBe(false);
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('stops the timer on shutdown and does not restart it', () => {
    const res = createMockResponse();
    service.addClient('client-a', res);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    service.sendReconnectToAll();

    expect(service.isHeartbeatRunning()).toBe(false);
    expect(clearSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    expect(res.write).not.toHaveBeenCalledWith(': keepalive\n\n');

    service.addClient('late-client', createMockResponse());
    expect(service.isHeartbeatRunning()).toBe(false);
  });
});
