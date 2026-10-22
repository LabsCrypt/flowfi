import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { rpc } from '@stellar/stellar-sdk';

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { RpcPool } from '../src/lib/rpc-pool.js';

function createMockServer(overrides: Partial<rpc.Server> = {}) {
  return {
    getHealth: vi.fn().mockResolvedValue({ status: 'healthy' }),
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: 1000 }),
    ...overrides,
  } as unknown as rpc.Server;
}

describe('RpcPool', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('execute timer management', () => {
    it('clears timeout timer on successful operation and does not abort signal later', async () => {
      const server1 = createMockServer();
      const pool = new RpcPool(['https://rpc1.example.com'], {
        timeoutMs: 5000,
        createServer: () => server1,
      });

      let capturedSignal!: AbortSignal;
      const resultPromise = pool.execute('test-op', async (_server, signal) => {
        capturedSignal = signal;
        return 'success-value';
      });

      const result = await resultPromise;
      expect(result).toBe('success-value');

      // Timer must be cleared immediately after settling
      expect(vi.getTimerCount()).toBe(0);

      // Advance time past the original timeout; signal must not be aborted
      await vi.advanceTimersByTimeAsync(10_000);
      expect(capturedSignal.aborted).toBe(false);
    });

    it('clears timeout timer on early failure before timeout', async () => {
      const server1 = createMockServer();
      const server2 = createMockServer();
      const servers = [server1, server2];
      let serverIndex = 0;

      const pool = new RpcPool(['https://rpc1.example.com', 'https://rpc2.example.com'], {
        timeoutMs: 5000,
        createServer: () => servers[serverIndex++] ?? server2,
      });

      let endpoint1Signal!: AbortSignal;
      let endpoint2Signal!: AbortSignal;
      let callCount = 0;

      const resultPromise = pool.execute('failover-op', async (_server, signal) => {
        callCount++;
        if (callCount === 1) {
          endpoint1Signal = signal;
          throw new Error('immediate rpc 1 network failure');
        }
        endpoint2Signal = signal;
        return 'recovered-value';
      });

      const result = await resultPromise;
      expect(result).toBe('recovered-value');
      expect(callCount).toBe(2);

      // Timers should be cleared
      expect(vi.getTimerCount()).toBe(0);

      // Advancing past timeoutMs should not abort endpoint 1 or endpoint 2
      await vi.advanceTimersByTimeAsync(10_000);
      expect(endpoint1Signal.aborted).toBe(false);
      expect(endpoint2Signal.aborted).toBe(false);
    });

    it('clears timeout timer when all endpoints fail early', async () => {
      const server1 = createMockServer();
      const pool = new RpcPool(['https://rpc1.example.com'], {
        timeoutMs: 5000,
        createServer: () => server1,
      });

      const resultPromise = pool.execute('all-fail', async () => {
        throw new Error('rpc unavailable');
      });

      await expect(resultPromise).rejects.toThrow('rpc unavailable');
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(10_000);
    });

    it('preserves timeout and aborts signal for genuinely hung requests, failing over', async () => {
      const server1 = createMockServer();
      const server2 = createMockServer();
      const servers = [server1, server2];
      let serverIndex = 0;

      const pool = new RpcPool(['https://rpc1.example.com', 'https://rpc2.example.com'], {
        timeoutMs: 3000,
        createServer: () => servers[serverIndex++] ?? server2,
      });

      let endpoint1Signal!: AbortSignal;
      let callCount = 0;

      const resultPromise = pool.execute('hung-op', async (_server, signal) => {
        callCount++;
        if (callCount === 1) {
          endpoint1Signal = signal;
          // Hang indefinitely until abort signal fires
          return new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => {
              reject(new Error('aborted by controller'));
            });
          });
        }
        return 'recovered-after-hang';
      });

      // Advance timers by 3000ms to trigger the timeout on endpoint 1
      await vi.advanceTimersByTimeAsync(3000);

      const result = await resultPromise;
      expect(result).toBe('recovered-after-hang');
      expect(callCount).toBe(2);
      expect(endpoint1Signal.aborted).toBe(true);

      // Post-recovery, timer count should be zero
      expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects with timeout when all endpoints genuinely hang', async () => {
      const server1 = createMockServer();
      const pool = new RpcPool(['https://rpc1.example.com'], {
        timeoutMs: 2000,
        createServer: () => server1,
      });

      let capturedSignal!: AbortSignal;
      const resultPromise = pool.execute('all-hang', async (_server, signal) => {
        capturedSignal = signal;
        return new Promise<never>(() => undefined);
      });

      await vi.advanceTimersByTimeAsync(2000);

      await expect(resultPromise).rejects.toThrow('all-hang timed out after 2000ms');
      expect(capturedSignal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('probeAll timer management', () => {
    it('clears timeout timer on successful health probe', async () => {
      const server1 = createMockServer({
        getHealth: vi.fn().mockResolvedValue({ status: 'healthy' }),
        getLatestLedger: vi.fn().mockResolvedValue({ sequence: 500 }),
      });

      const pool = new RpcPool(['https://rpc1.example.com'], {
        timeoutMs: 4000,
        createServer: () => server1,
      });

      await pool.probe();
      expect(vi.getTimerCount()).toBe(0);

      const [health] = pool.getHealth();
      expect(health?.state).toBe('CLOSED');
      expect(health?.failures).toBe(0);
    });

    it('clears timeout timer on early probe failure', async () => {
      const server1 = createMockServer({
        getHealth: vi.fn().mockRejectedValue(new Error('endpoint down')),
        getLatestLedger: vi.fn().mockResolvedValue({ sequence: 500 }),
      });

      const pool = new RpcPool(['https://rpc1.example.com'], {
        timeoutMs: 4000,
        createServer: () => server1,
      });

      await pool.probe();
      expect(vi.getTimerCount()).toBe(0);

      const [health] = pool.getHealth();
      expect(health?.failures).toBe(1);
    });

    it('handles probe timeout when probe genuinely hangs', async () => {
      const server1 = createMockServer({
        getHealth: vi.fn().mockReturnValue(new Promise(() => undefined)),
        getLatestLedger: vi.fn().mockReturnValue(new Promise(() => undefined)),
      });

      const pool = new RpcPool(['https://rpc1.example.com'], {
        timeoutMs: 2000,
        createServer: () => server1,
      });

      const probePromise = pool.probe();
      await vi.advanceTimersByTimeAsync(2000);
      await probePromise;

      expect(vi.getTimerCount()).toBe(0);
      const [health] = pool.getHealth();
      expect(health?.failures).toBe(1);
    });
  });
});
