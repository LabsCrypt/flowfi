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
