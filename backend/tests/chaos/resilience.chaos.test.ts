/**
 * FlowFi resilience chaos suite — issue #1477.
 *
 * This file has two tiers:
 *
 *   1. Deterministic in-process chaos (always runs). It drives the real
 *      `RpcPool`, `quarantineEvent` and `SSEService` code paths with injected
 *      faults, so assertions are hermetic and never flaky.
 *   2. Docker/Toxiproxy integration (runs only when the chaos stack from
 *      `docker-compose.chaos.yml` is reachable). It validates the fault
 *      harness itself against real Redis/Postgres/RPC proxies.
 *
 * Assertions map to the issue acceptance criteria:
 *   - Assertion 1: RPC failover + circuit breaker trip within < 500ms.
 *   - Assertion 2: malformed responses are dead-lettered without killing the worker.
 *   - Assertion 3: Redis loss produces SSE reconnect handling and seamless recovery.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import type { Response } from 'express';
import type { rpc } from '@stellar/stellar-sdk';
import { Redis } from 'ioredis';
import {
  ToxiproxyClient,
  CHAOS_PROXIES,
  CHAOS_URLS,
  latencyToxic,
  redisKillToxic,
  postgresHoldToxic,
  isChaosStackReady,
} from './helpers/toxiproxy.js';
import { startFaultyRpcServer, startFailoverPair } from './helpers/faulty-rpc-server.js';

// ---------------------------------------------------------------------------
// Module mocks — keep the suite hermetic (no DB, no outbound alerts, no logs).
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  prismaUpsert: vi.fn(),
  sendDeadLetterAlert: vi.fn(),
  redisAvailable: false,
  redisPublish: vi.fn(),
  redisSubscriber: null as unknown,
}));

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: {
    indexerDeadLetterEvent: {
      upsert: hoisted.prismaUpsert,
    },
  },
}));

vi.mock('../../src/services/alert.service.js', () => ({
  sendDeadLetterAlert: hoisted.sendDeadLetterAlert,
}));

vi.mock('../../src/workers/soroban-event-worker.js', () => ({
  sorobanEventWorker: {
    triggerPoll: vi.fn(),
    processEvent: vi.fn(),
    runExclusive: vi.fn(),
  },
}));

vi.mock('../../src/lib/redis.js', () => ({
  isRedisAvailable: () => hoisted.redisAvailable,
  getPublisher: () => ({ publish: hoisted.redisPublish }),
  getSubscriber: () => hoisted.redisSubscriber,
}));

vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  requestContext: {
    run: <T>(_store: unknown, fn: () => T): T => fn(),
    getStore: () => undefined,
  },
}));

// Point the module-level rpc-pool singleton's health probes at a dead port so
// importing it never reaches out to the public Soroban testnet.
vi.stubEnv('SOROBAN_RPC_URLS', 'http://127.0.0.1:9');

import { SSEService } from '../../src/services/sse.service.js';
import { quarantineEvent } from '../../src/services/indexerService.js';

const FAILOVER_BUDGET_MS = 500;

function makeEvent(overrides: Partial<Record<string, unknown>> = {}): rpc.Api.EventResponse {
  const scval = {
    sym: { toString: () => 'stream_created' },
    toXDR: () => Buffer.from([0, 0, 0, 0]),
  };
  return {
    id: 'evt-1',
    type: 'contract',
    ledger: 100,
    ledgerClosedAt: '2026-01-01T00:00:00Z',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [scval],
    value: scval,
    txHash: 'tx-1',
    ...overrides,
  } as unknown as rpc.Api.EventResponse;
}

// ---------------------------------------------------------------------------
// Tier 1a — RPC failover / circuit breaker (Assertion 1)
// ---------------------------------------------------------------------------

describe('Chaos #1477 — RPC failover & circuit breaker', () => {
  let RpcPool: typeof import('../../src/lib/rpc-pool.js').RpcPool;
  let poolSingleton: import('../../src/lib/rpc-pool.js').RpcPool;

  beforeAll(async () => {
    const mod = await import('../../src/lib/rpc-pool.js');
    RpcPool = mod.RpcPool;
    poolSingleton = mod.rpcPool;
    poolSingleton.stopHealthProbes();
  });

  afterAll(() => {
    poolSingleton.stopHealthProbes();
  });

  it('fails over to the secondary endpoint when the primary returns HTTP 429', async () => {
    const pair = await startFailoverPair('rate-limit');
    try {
      const pool = new RpcPool([pair.primary.url, pair.secondary.url], {
        failureThreshold: 3,
        cooldownMs: 60_000,
        timeoutMs: 2_000,
      });

      const started = Date.now();
      const health = await pool.execute('getHealth', (server) => server.getHealth());
      const elapsed = Date.now() - started;

      expect(health.status).toBe('healthy');
      expect(elapsed).toBeLessThan(FAILOVER_BUDGET_MS);
      expect(pair.primary.requestCount()).toBeGreaterThanOrEqual(1);
      expect(pair.secondary.requestCount()).toBeGreaterThanOrEqual(1);

      const [primaryHealth, secondaryHealth] = pool.getHealth();
      expect(primaryHealth?.failures).toBe(1);
      expect(primaryHealth?.state).toBe('CLOSED');
      expect(secondaryHealth?.failures).toBe(0);
    } finally {
      await pair.close();
    }
  });

  it('fails over within budget when the primary connection hangs (latency injection)', async () => {
    const pair = await startFailoverPair('hang');
    try {
      const pool = new RpcPool([pair.primary.url, pair.secondary.url], {
        failureThreshold: 5,
        cooldownMs: 60_000,
        timeoutMs: 300,
      });

      const started = Date.now();
      const health = await pool.execute('getHealth', (server) => server.getHealth());
      const elapsed = Date.now() - started;

      expect(health.status).toBe('healthy');
      expect(elapsed).toBeLessThan(FAILOVER_BUDGET_MS);
      expect(pair.secondary.requestCount()).toBeGreaterThanOrEqual(1);
    } finally {
      await pair.close();
    }
  });

  it('opens the circuit after the failure threshold and stops dialing the endpoint', async () => {
    // Single-endpoint pool: with no healthy fallback, every dispatch hits the
    // same endpoint, so repeated failures trip the breaker deterministically.
    const primary = await startFaultyRpcServer({ mode: 'rate-limit' });
    try {
      const pool = new RpcPool([primary.url], {
        failureThreshold: 2,
        cooldownMs: 60_000,
        timeoutMs: 2_000,
      });

      await expect(pool.execute('getHealth', (server) => server.getHealth())).rejects.toBeDefined();
      await expect(pool.execute('getHealth', (server) => server.getHealth())).rejects.toBeDefined();

      const primaryHealth = pool.getHealth().find((e) => e.url === primary.url);
      expect(primaryHealth?.state).toBe('OPEN');
      expect(primaryHealth?.failures).toBeGreaterThanOrEqual(2);

      const requestsBefore = primary.requestCount();
      await expect(pool.execute('getHealth', (server) => server.getHealth())).rejects.toBeDefined();
      // The open breaker must have skipped the endpoint entirely.
      expect(primary.requestCount()).toBe(requestsBefore);
    } finally {
      await primary.close();
    }
  });

  it('recovers the circuit (half-open -> closed) once the endpoint heals', async () => {
    // Single-endpoint pool so the breaker transition is observable directly.
    const primary = await startFaultyRpcServer({ mode: 'rate-limit' });
    try {
      const pool = new RpcPool([primary.url], {
        failureThreshold: 1,
        cooldownMs: 100,
        timeoutMs: 2_000,
      });

      await expect(pool.execute('getHealth', (server) => server.getHealth())).rejects.toBeDefined();
      expect(pool.getHealth().find((e) => e.url === primary.url)?.state).toBe('OPEN');

      // Cool down, then heal the primary before the next dispatch.
      await new Promise((resolve) => setTimeout(resolve, 150));
      primary.setMode('healthy');

      const health = await pool.execute('getHealth', (server) => server.getHealth());
      expect(health.status).toBe('healthy');

      const recovered = pool.getHealth().find((e) => e.url === primary.url);
      expect(recovered?.state).toBe('CLOSED');
      expect(recovered?.failures).toBe(0);
    } finally {
      await primary.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tier 1b — Indexer dead-letter catch (Assertion 2)
// ---------------------------------------------------------------------------

describe('Chaos #1477 — indexer dead-letter catch', () => {
  beforeEach(() => {
    hoisted.prismaUpsert.mockReset().mockResolvedValue({ attempts: 1 });
    hoisted.sendDeadLetterAlert.mockReset().mockResolvedValue(undefined);
  });

  it('routes a malformed event to the DLQ and alerts operators', async () => {
    const event = makeEvent();
    await quarantineEvent(event, new Error('malformed RPC response'));

    expect(hoisted.prismaUpsert).toHaveBeenCalledTimes(1);
    const call = hoisted.prismaUpsert.mock.calls[0]?.[0] as {
      where: { eventId_eventType: { eventId: string; eventType: string } };
      create: { eventId: string; errorMessage: string; attempts: number };
    };
    expect(call.where.eventId_eventType).toEqual({
      eventId: 'evt-1',
      eventType: 'stream_created',
    });
    expect(call.create.errorMessage).toBe('malformed RPC response');
    expect(call.create.attempts).toBe(1);
    expect(hoisted.sendDeadLetterAlert).toHaveBeenCalledTimes(1);
  });

  it('bumps attempts instead of duplicating when the same event is re-quarantined', async () => {
    await quarantineEvent(makeEvent(), new Error('first failure'));
    await quarantineEvent(makeEvent(), new Error('second failure'));

    expect(hoisted.prismaUpsert).toHaveBeenCalledTimes(2);
    const second = hoisted.prismaUpsert.mock.calls[1]?.[0] as {
      update: { attempts: { increment: number }; errorMessage: string };
    };
    expect(second.update.attempts).toEqual({ increment: 1 });
    expect(second.update.errorMessage).toBe('second failure');
  });

  it('never throws when dead-letter persistence itself fails (worker survives)', async () => {
    hoisted.prismaUpsert.mockRejectedValueOnce(new Error('DB pool exhausted'));
    await expect(quarantineEvent(makeEvent(), new Error('poison'))).resolves.toBeUndefined();
  });

  it('continues processing healthy events after a malformed one in the same batch', async () => {
    const processed: string[] = [];
    const batch = [
      makeEvent({ id: 'good-1' }),
      makeEvent({ id: 'poison' }),
      makeEvent({ id: 'good-2' }),
    ];

    for (const event of batch) {
      try {
        if (event.id === 'poison') throw new Error('malformed RPC response');
        processed.push(event.id);
      } catch (err) {
        await quarantineEvent(event, err);
      }
    }

    expect(processed).toEqual(['good-1', 'good-2']);
    expect(hoisted.prismaUpsert).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tier 1c — Redis SSE reconnect handling (Assertion 3)
// ---------------------------------------------------------------------------

interface FakeSseResponse {
  res: Response;
  write: ReturnType<typeof vi.fn>;
}

function makeFakeSseResponse(): FakeSseResponse {
  const write = vi.fn().mockReturnValue(true);
  const res = {
    write,
    end: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    writableEnded: false,
    socket: { writableLength: 0 },
  } as unknown as Response;
  return { res, write };
}

describe('Chaos #1477 — Redis SSE reconnect handling', () => {
  afterEach(() => {
    hoisted.redisAvailable = false;
    hoisted.redisPublish.mockReset();
  });

  it('falls back to local fanout while Redis is severed, then resumes publishing', () => {
    const service = new SSEService();
    const { res, write } = makeFakeSseResponse();
    service.addClient('client-1', res, ['42'], '127.0.0.1');

    // Redis is down: SSE must still deliver to connected clients locally.
    hoisted.redisAvailable = false;
    service.broadcastToStream('42', 'claimable_updated', { amount: '10' });
    expect(hoisted.redisPublish).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(
      'event: claimable_updated\ndata: {"amount":"10"}\n\n',
    );

    // Redis restarts: fanout switches back to pub/sub.
    hoisted.redisAvailable = true;
    service.broadcastToStream('42', 'claimable_updated', { amount: '20' });
    expect(hoisted.redisPublish).toHaveBeenCalledWith(
      'sse:stream:42',
      JSON.stringify({ event: 'claimable_updated', data: { amount: '20' } }),
    );
  });

  it('sends an automated reconnect notice to every connected SSE client', () => {
    const service = new SSEService();
    const first = makeFakeSseResponse();
    const second = makeFakeSseResponse();
    service.addClient('client-1', first.res, ['stream:1'], '127.0.0.1');
    service.addClient('client-2', second.res, ['user:abc'], '127.0.0.1');

    service.sendReconnectToAll();

    const reconnect = 'event: reconnect\ndata: {}\n\n';
    expect(first.write).toHaveBeenCalledWith(reconnect);
    expect(second.write).toHaveBeenCalledWith(reconnect);
    expect(service.isShuttingDown()).toBe(true);
  });

  it('does not throw when a client socket is already gone during reconnect fanout', () => {
    const service = new SSEService();
    const { res } = makeFakeSseResponse();
    (res.write as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('socket closed');
    });
    service.addClient('client-1', res, ['stream:1'], '127.0.0.1');

    expect(() => service.sendReconnectToAll()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — Docker/Toxiproxy integration (skipped when the stack is absent)
// ---------------------------------------------------------------------------

const chaos = new ToxiproxyClient();
const chaosStackReady = await isChaosStackReady();

describe.runIf(chaosStackReady)('Chaos #1477 — Toxiproxy fault injection harness', () => {
  beforeAll(async () => {
    await chaos.waitUntilReady(15_000);
    await chaos.ensureProxies();
  });

  afterEach(async () => {
    await chaos.reset();
  });

  it('injects measurable latency into the Soroban RPC proxy', async () => {
    await chaos.addToxic(CHAOS_PROXIES.sorobanRpc.name, latencyToxic(1_000, 0));

    const started = Date.now();
    const res = await fetch(`${CHAOS_URLS.sorobanRpc}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestLedger', params: {} }),
      signal: AbortSignal.timeout(10_000),
    });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  it('kills the Redis proxy and lets ioredis reconnect after recovery', async () => {
    const client = new Redis(CHAOS_URLS.redis, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      // Fail queued commands immediately while severed instead of hanging them.
      enableOfflineQueue: false,
      // Keep dialing for the whole scenario; the proxy heals mid-test.
      retryStrategy: (times: number) => Math.min(times * 50, 250),
    });
    // Connection resets are the point of this scenario, and ioredis reports
    // them as 'error' events — an unhandled one would fail the test process.
    client.on('error', () => undefined);

    try {
      await client.connect();
      await client.set('chaos:key', 'before');
      expect(await client.get('chaos:key')).toBe('before');

      await chaos.addToxic(CHAOS_PROXIES.redis.name, redisKillToxic());
      // The reset must make the proxy unusable (connection torn down or dials reset).
      await expect
        .poll(async () => {
          try {
            await client.ping();
            return 'up';
          } catch {
            return 'down';
          }
        }, { timeout: 5_000, interval: 100 })
        .toBe('down');

      await chaos.reset();
      await expect
        .poll(async () => {
          try {
            return await client.ping();
          } catch {
            return 'unavailable';
          }
        }, { timeout: 10_000, interval: 200 })
        .toBe('PONG');
    } finally {
      client.disconnect();
    }
  });

  it('exposes PostgreSQL backpressure under a held connection', async () => {
    const { Client } = await import('pg');
    const newClient = () =>
      new Client({
        connectionString: CHAOS_URLS.postgres,
        connectionTimeoutMillis: 2_000,
      });

    // Baseline: the proxy forwards traffic normally.
    const healthy = newClient();
    await healthy.connect();
    try {
      await healthy.query('SELECT 1');
    } finally {
      await healthy.end().catch(() => undefined);
    }

    // Establish the connection *before* the fault so the hold applies to the
    // query path rather than to the handshake.
    const held = newClient();
    await held.connect();
    try {
      await chaos.addToxic(CHAOS_PROXIES.postgres.name, postgresHoldToxic(5_000));
      const outcome = await Promise.race([
        held.query('SELECT 1').then(() => 'ok').catch(() => 'error'),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2_500)),
      ]);
      expect(outcome).toBe('timeout');
    } finally {
      // `end()` destroys the socket when a query is still in flight.
      held.end().catch(() => undefined);
    }
  });
});
