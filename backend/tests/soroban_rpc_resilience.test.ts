import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import logger from '../src/logger.js';

/**
 * Deadline, backoff and breaker instrumentation of `sorobanService.ts` (#1754).
 *
 * `tests/soroban.service.test.ts` proves that `withRpcTimeout` rejects a hung
 * call and that `withRpcRetry` retries a transient one. What those tests cannot
 * see is what this file pins: the timers they leave behind (a leaked deadline
 * keeps firing into an already-settled race), the wall-clock spacing of the
 * backoff, the env-configurable boundaries, the classification of every error
 * shape a dependency can throw, and the Prometheus series an operator alerts on.
 *
 * The RPC pool is stubbed so the module can be imported with a deliberately
 * malformed `SOROBAN_RPC_URL`; nothing here talks to a server.
 *
 * Metrics are read from the same module generation as the service under test:
 * `vi.resetModules()` re-evaluates `lib/metrics.js`, so a counters handle
 * captured at import time would point at an abandoned registry and stay at zero.
 */

vi.mock('../src/lib/rpc-pool.js', () => ({
  rpcPool: { execute: vi.fn(() => Promise.reject(new Error('pool must not be used'))) },
}));

vi.mock('../src/logger.js', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

/**
 * Sum the counter's series whose labels are a superset of `labels`.
 *
 * `Counter.get(labels)` is deliberately not used: prom-client returns every
 * series regardless of the filter object, so a partially-labelled query would
 * read whichever counter was touched last.
 */
async function counterValue(counter: unknown, labels: Record<string, string>): Promise<number> {
  const metric = await (
    counter as { get: () => Promise<{ values?: Array<{ value: number; labels?: Record<string, string> }> }> }
  ).get();
  return (metric?.values ?? [])
    .filter((value) => Object.entries(labels).every(([name, want]) => value.labels?.[name] === want))
    .reduce((sum, value) => sum + value.value, 0);
}

const MANAGED_ENV = [
  'SOROBAN_RPC_URL',
  'SOROBAN_RPC_TIMEOUT_MS',
  'SOROBAN_RPC_MAX_RETRIES',
  'SOROBAN_RPC_RETRY_BASE_MS',
] as const;

interface Generation {
  withRpcTimeout: typeof import('../src/services/sorobanService.js').withRpcTimeout;
  withRpcRetry: typeof import('../src/services/sorobanService.js').withRpcRetry;
  RpcTimeoutError: typeof import('../src/services/sorobanService.js').RpcTimeoutError;
  rpcEndpointLabel: typeof import('../src/services/sorobanService.js').rpcEndpointLabel;
  metrics: typeof import('../src/lib/metrics.js');
}

/** Fresh service module with `env` applied, so module-level constants are re-read. */
async function loadService(env: Record<string, string> = {}): Promise<Generation> {
  for (const key of MANAGED_ENV) delete process.env[key];
  Object.assign(process.env, { SOROBAN_RPC_URL: 'https://rpc.test', ...env });

  vi.resetModules();
  const metrics = await import('../src/lib/metrics.js');
  const service = await import('../src/services/sorobanService.js');

  return {
    withRpcTimeout: service.withRpcTimeout,
    withRpcRetry: service.withRpcRetry,
    RpcTimeoutError: service.RpcTimeoutError,
    rpcEndpointLabel: service.rpcEndpointLabel,
    metrics,
  };
}

/** Settle a promise without leaving an unhandled rejection while timers advance. */
function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function transientMessageCase(label: string, message: string) {
  return { label, build: () => new Error(message), retried: true };
}

function fatalMessageCase(label: string, message: string) {
  return { label, build: () => new Error(message), retried: false };
}

/** Constructor shape of the service's RpcTimeoutError, for the table below. */
type TimeoutErrorCtor = new (label: string, timeoutMs: number) => Error;

afterEach(() => {
  vi.useRealTimers();
  for (const key of MANAGED_ENV) delete process.env[key];
});

describe('withRpcTimeout — deadline configuration', () => {
  it('applies SOROBAN_RPC_TIMEOUT_MS when the caller does not pass a deadline', async () => {
    const { withRpcTimeout, RpcTimeoutError } = await loadService({
      SOROBAN_RPC_TIMEOUT_MS: '1500',
    });
    vi.useFakeTimers();

    let failure: unknown = null;
    const hung = settle(
      withRpcTimeout('defaultDeadline', () => new Promise<string>(() => {})),
    ).then((result) => {
      failure = result.ok ? null : result.error;
      return result;
    });

    await vi.advanceTimersByTimeAsync(1499);
    expect(failure).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    const result = await hung;
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error).toBeInstanceOf(RpcTimeoutError);
    expect((failure as Error).message).toBe('defaultDeadline timed out after 1500ms');
  });

  it('defaults to a 10 second deadline when the env var is unset', async () => {
    const { withRpcTimeout } = await loadService();
    vi.useFakeTimers();

    let settled = false;
    const hung = settle(
      withRpcTimeout('unsetDeadline', () => new Promise<string>(() => {})),
    ).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await hung).ok).toBe(false);
    expect(settled).toBe(true);
  });
});

describe('withRpcTimeout — timer and signal cleanup', () => {
  it('leaves no pending timer after a successful call', async () => {
    const { withRpcTimeout } = await loadService();
    vi.useFakeTimers();

    await expect(withRpcTimeout('ok', async () => 'value', 5_000)).resolves.toBe('value');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no pending timer after the call fails before the deadline', async () => {
    const { withRpcTimeout } = await loadService();
    vi.useFakeTimers();
    const boom = new Error('ECONNRESET');

    await expect(
      withRpcTimeout('early', () => Promise.reject<string>(boom), 5_000),
    ).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no pending timer after firing the deadline', async () => {
    const { withRpcTimeout, RpcTimeoutError } = await loadService();
    vi.useFakeTimers();

    const hung = settle(withRpcTimeout('hang', () => new Promise<string>(() => {}), 5_000));
    await vi.advanceTimersByTimeAsync(5_000);

    const result = await hung;
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error).toBeInstanceOf(RpcTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not abort the signal when the call settles inside the deadline', async () => {
    const { withRpcTimeout } = await loadService();
    vi.useFakeTimers();

    const seen: AbortSignal[] = [];
    await withRpcTimeout('fast', (signal) => {
      seen.push(signal);
      return Promise.resolve('value');
    }, 5_000);

    await expect(
      withRpcTimeout('fails', (signal) => {
        seen.push(signal);
        return Promise.reject(new Error('validation failed'));
      }, 5_000),
    ).rejects.toThrow('validation failed');

    expect(seen).toHaveLength(2);
    expect(seen.every((signal) => signal.aborted)).toBe(false);

    // A cleared deadline must not abort retroactively once the call settled.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seen.every((signal) => signal.aborted)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('withRpcTimeout — RPC metrics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('counts a success and trips nothing', async () => {
    const { withRpcTimeout, metrics } = await loadService();
    const before = await counterValue(metrics.rpcRequestsTotal, {
      method: 'okCount',
      outcome: 'success',
    });

    await withRpcTimeout('okCount', async () => 'value', 5_000);

    expect(await counterValue(metrics.rpcRequestsTotal, { method: 'okCount', outcome: 'success' })).toBe(
      before + 1,
    );
    expect(await counterValue(metrics.rpcCircuitBreakerTripsTotal, { method: 'okCount' })).toBe(0);
  });

  it('records the timeout outcome and trips the breaker for that endpoint and method', async () => {
    const { withRpcTimeout, metrics } = await loadService({
      SOROBAN_RPC_URL: 'https://rpc.test:8000/soroban',
    });
    const before = await counterValue(metrics.rpcRequestsTotal, {
      method: 'timeoutCount',
      outcome: 'timeout',
    });
    const tripsBefore = await counterValue(metrics.rpcCircuitBreakerTripsTotal, {
      endpoint: 'rpc.test:8000',
      method: 'timeoutCount',
    });

    const hung = settle(withRpcTimeout('timeoutCount', () => new Promise<string>(() => {}), 1_000));
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await hung).ok).toBe(false);

    expect(await counterValue(metrics.rpcRequestsTotal, { method: 'timeoutCount', outcome: 'timeout' })).toBe(
      before + 1,
    );
    expect(
      await counterValue(metrics.rpcCircuitBreakerTripsTotal, {
        endpoint: 'rpc.test:8000',
        method: 'timeoutCount',
      }),
    ).toBe(tripsBefore + 1);
    expect(await counterValue(metrics.rpcRequestsTotal, { method: 'timeoutCount', outcome: 'success' })).toBe(
      0,
    );
  });

  it('records a non-timeout failure as an error without tripping the breaker', async () => {
    const { withRpcTimeout, metrics } = await loadService();

    await expect(
      withRpcTimeout('errorCount', () => Promise.reject(new Error('HTTP 404 Not Found')), 5_000),
    ).rejects.toThrow('HTTP 404 Not Found');

    expect(await counterValue(metrics.rpcRequestsTotal, { method: 'errorCount', outcome: 'error' })).toBe(1);
    expect(await counterValue(metrics.rpcRequestsTotal, { method: 'errorCount', outcome: 'timeout' })).toBe(0);
    expect(await counterValue(metrics.rpcCircuitBreakerTripsTotal, { method: 'errorCount' })).toBe(0);
  });

  it('labels the endpoint by host so a query string cannot mint new series', async () => {
    const { rpcEndpointLabel } = await loadService({
      SOROBAN_RPC_URL: 'https://rpc.test:8000/soroban?token=abc',
    });
    expect(rpcEndpointLabel()).toBe('rpc.test:8000');
  });

  it('reports an unparseable endpoint as unknown instead of throwing', async () => {
    const { rpcEndpointLabel } = await loadService({ SOROBAN_RPC_URL: 'not-a-url' });
    expect(rpcEndpointLabel()).toBe('unknown');
  });
});

describe('withRpcRetry — backoff schedule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('doubles the wait between attempts: 250ms, 500ms, 1000ms', async () => {
    const { withRpcRetry, metrics } = await loadService();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 4) throw new Error('fetch failed');
      return 'recovered';
    });
    const failoversBefore = await counterValue(metrics.rpcFailoversTotal, { method: 'schedule' });

    const pending = settle(withRpcRetry('schedule', fn, 3));

    // Each step is asserted at both its boundary and one tick past it, so a
    // linear (base * attempt) schedule cannot pass: the third wait is 1000ms,
    // not 750ms.
    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(749);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: true, value: 'recovered' });
    expect(calls).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
    expect(await counterValue(metrics.rpcFailoversTotal, { method: 'schedule' })).toBe(
      failoversBefore + 3,
    );
  });

  it('honours SOROBAN_RPC_RETRY_BASE_MS and SOROBAN_RPC_MAX_RETRIES when the caller passes neither', async () => {
    const { withRpcRetry, RpcTimeoutError, metrics } = await loadService({
      SOROBAN_RPC_RETRY_BASE_MS: '1000',
      SOROBAN_RPC_MAX_RETRIES: '1',
    });
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      throw new RpcTimeoutError('envRetry', 10);
    });
    const tripsBefore = await counterValue(metrics.rpcCircuitBreakerTripsTotal, {
      endpoint: 'rpc.test',
      method: 'envRetry',
    });

    const failure = settle(withRpcRetry('envRetry', fn));

    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    const result = await failure;
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error).toBeInstanceOf(RpcTimeoutError);
    expect(calls).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      await counterValue(metrics.rpcCircuitBreakerTripsTotal, {
        endpoint: 'rpc.test',
        method: 'envRetry',
      }),
    ).toBe(tripsBefore + 1);
  });

  it('makes exactly maxRetries + 1 attempts and then gives up', async () => {
    const { withRpcRetry, metrics } = await loadService();
    const last = new Error('ECONNREFUSED');
    const fn = vi.fn(async () => {
      throw last;
    });
    const failoversBefore = await counterValue(metrics.rpcFailoversTotal, { method: 'exhaust' });
    const tripsBefore = await counterValue(metrics.rpcCircuitBreakerTripsTotal, {
      endpoint: 'rpc.test',
      method: 'exhaust',
    });

    const failure = settle(withRpcRetry('exhaust', fn, 3));
    await vi.runAllTimersAsync();

    expect(await failure).toEqual({ ok: false, error: last });
    expect(fn).toHaveBeenCalledTimes(4);
    expect(await counterValue(metrics.rpcFailoversTotal, { method: 'exhaust' })).toBe(
      failoversBefore + 3,
    );
    expect(
      await counterValue(metrics.rpcCircuitBreakerTripsTotal, {
        endpoint: 'rpc.test',
        method: 'exhaust',
      }),
    ).toBe(tripsBefore + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('issues a single attempt and no sleep when maxRetries is zero', async () => {
    const { withRpcRetry, metrics } = await loadService();
    const boom = new Error('fetch failed');
    const fn = vi.fn(async () => {
      throw boom;
    });

    expect(await settle(withRpcRetry('noRetry', fn, 0))).toEqual({ ok: false, error: boom });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(await counterValue(metrics.rpcFailoversTotal, { method: 'noRetry' })).toBe(0);
  });

  it('returns the first result without sleeping when nothing fails', async () => {
    const { withRpcRetry, metrics } = await loadService();
    const fn = vi.fn(async () => 'immediate');

    await expect(withRpcRetry('happy', fn, 3)).resolves.toBe('immediate');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(await counterValue(metrics.rpcFailoversTotal, { method: 'happy' })).toBe(0);
  });

  it('warns with the attempt number and the delay actually scheduled', async () => {
    const { withRpcRetry } = await loadService();
    const fn = vi.fn(async () => {
      throw new Error('EAI_AGAIN rpc.test');
    });

    const failure = settle(withRpcRetry('warned', fn, 1));
    await vi.runAllTimersAsync();
    await failure;

    const warnings = vi.mocked(logger.warn).mock.calls.map((call) => String(call[0]));
    expect(warnings.some((line) => line.includes('warned attempt 1/1'))).toBe(true);
    expect(warnings.some((line) => line.includes('retrying in 250ms'))).toBe(true);
    expect(warnings.some((line) => line.includes('EAI_AGAIN'))).toBe(true);
  });
});

describe('withRpcRetry — error classification', () => {
  const cases: Array<{
    label: string;
    build: (timeoutError: TimeoutErrorCtor) => unknown;
    retried: boolean;
  }> = [
    { label: 'RpcTimeoutError', build: (Ctor) => new Ctor('inner', 1), retried: true },
    {
      label: 'AbortError by name',
      build: () => Object.assign(new Error('signal aborted'), { name: 'AbortError' }),
      retried: true,
    },
    transientMessageCase('connection reset', 'read ECONNRESET'),
    transientMessageCase('connection refused', 'connect ECONNREFUSED 127.0.0.1:8000'),
    transientMessageCase('dns miss', 'getaddrinfo ENOTFOUND rpc.test'),
    transientMessageCase('dns retry', 'getaddrinfo EAI_AGAIN rpc.test'),
    transientMessageCase('timeout wording', 'request timeout while awaiting response'),
    transientMessageCase('timed out wording', 'simulator timed out after 10000ms'),
    transientMessageCase('network wording', 'temporary network issue'),
    transientMessageCase('fetch failed', 'fetch failed'),
    transientMessageCase('HTTP 502', 'HTTP 502 Bad Gateway from RPC'),
    transientMessageCase('HTTP 503', 'HTTP 503 Service Unavailable from RPC'),
    transientMessageCase('HTTP 504', 'HTTP 504 Gateway Timeout from RPC'),
    { label: 'thrown string that looks transient', build: () => 'timed out', retried: true },
    fatalMessageCase('HTTP 500', 'HTTP 500 Internal Server Error from RPC'),
    fatalMessageCase('contract error', 'Error(Contract, #2): stream not found'),
    fatalMessageCase('validation error', 'params.amount must be greater than zero'),
    { label: 'thrown string that looks fatal', build: () => 'validation failed', retried: false },
  ];

  for (const testCase of cases) {
    it(`${testCase.label}: ${testCase.retried ? 'retried' : 'raised immediately'}`, async () => {
      vi.useFakeTimers();
      const { withRpcRetry, RpcTimeoutError, metrics } = await loadService();
      const thrown = testCase.build(RpcTimeoutError);

      let calls = 0;
      const fn = vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw thrown;
        return 'second attempt ok';
      });
      const failoversBefore = await counterValue(metrics.rpcFailoversTotal, { method: 'classify' });

      const outcome = settle(withRpcRetry('classify', fn, 1));
      await vi.runAllTimersAsync();
      const result = await outcome;

      if (testCase.retried) {
        expect(result).toEqual({ ok: true, value: 'second attempt ok' });
        expect(calls).toBe(2);
        expect(await counterValue(metrics.rpcFailoversTotal, { method: 'classify' })).toBe(
          failoversBefore + 1,
        );
      } else {
        // Identity, not message: the caller receives exactly what the
        // dependency threw rather than a retry wrapper.
        expect(result.ok).toBe(false);
        expect(result.ok ? null : result.error).toBe(thrown);
        expect(calls).toBe(1);
        expect(await counterValue(metrics.rpcFailoversTotal, { method: 'classify' })).toBe(
          failoversBefore,
        );
      }
      expect(vi.getTimerCount()).toBe(0);
    });
  }
});
