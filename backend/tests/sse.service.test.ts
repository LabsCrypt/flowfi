import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SSEService } from '../src/services/sse.service.js';

function createMockResponse() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { write: vi.fn() });
}

describe('SSEService connection limits', () => {
  const originalMax = process.env.MAX_SSE_CONNECTIONS;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MAX_SSE_CONNECTIONS = '10000';
  });

  afterEach(() => {
    process.env.MAX_SSE_CONNECTIONS = originalMax;
  });

  it('rejects the 6th concurrent connection from the same IP with 429', () => {
    const service = new SSEService();

    for (let i = 0; i < 5; i += 1) {
      const capacity = service.checkCapacity('127.0.0.1');
      expect(capacity.allowed).toBe(true);
      const res = createMockResponse();
      service.addClient(`ip-client-${i}`, res as any, ['*'], '127.0.0.1');
    }

    const sixth = service.checkCapacity('127.0.0.1');
    expect(sixth.allowed).toBe(false);
    expect(sixth.status).toBe(429);
    expect(sixth.retryAfterSeconds).toBe(60);
  });

  it('rejects connections when global capacity is reached with 503', () => {
    process.env.MAX_SSE_CONNECTIONS = '2';
    const service = new SSEService();

    service.addClient('client-1', createMockResponse() as any, ['*'], '10.0.0.1');
    service.addClient('client-2', createMockResponse() as any, ['*'], '10.0.0.2');

    const blocked = service.checkCapacity('10.0.0.3');
    expect(blocked.allowed).toBe(false);
    expect(blocked.status).toBe(503);
  });

  it('cleans up IP tracking when all connections from that IP close', () => {
    const service = new SSEService();
    const resA = createMockResponse();
    const resB = createMockResponse();

    service.addClient('client-a', resA as any, ['*'], '10.10.10.10');
    service.addClient('client-b', resB as any, ['*'], '10.10.10.10');

    expect(service.getActiveIpCount()).toBe(1);

    resA.emit('close');
    expect(service.getActiveIpCount()).toBe(1);

    resB.emit('close');
    expect(service.getActiveIpCount()).toBe(0);
  });
});
