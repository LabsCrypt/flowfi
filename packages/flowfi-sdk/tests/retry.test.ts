import { describe, it, expect, vi } from 'vitest';
import {
  pollTransactionWithRetry,
  pollUntil,
  isRetryableError,
  PollRetryExhaustedError,
  type PollRetryOptions,
} from '../src/retry.js';

/**
 * Test harness: a deterministic fake clock that records each sleep()
 * call so we can assert the exact backoff schedule.
 */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

/** Zero-jitter random so delay assertions are exact. */
const noJitter = () => 0.5;

function opts(overrides: Partial<PollRetryOptions>): PollRetryOptions {
  return { random: noJitter, ...overrides };
}

describe('isRetryableError', () => {
  it('retries on 429', () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
  });
  it('retries on 500-599', () => {
    expect(isRetryableError({ status: 500 })).toBe(true);
    expect(isRetryableError({ status: 503 })).toBe(true);
    expect(isRetryableError({ statusCode: 502 })).toBe(true);
  });
  it('fails fast on other 4xx', () => {
    expect(isRetryableError({ status: 400 })).toBe(false);
    expect(isRetryableError({ status: 404 })).toBe(false);
  });
  it('retries on AbortError / timeouts', () => {
    expect(isRetryableError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
  });
  it('retries on common network error codes', () => {
    expect(isRetryableError({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
  });
  it('retries on "fetch failed" message', () => {
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
  });
  it('explicit retryable:false wins', () => {
    expect(isRetryableError({ retryable: false, status: 500 })).toBe(false);
  });
  it('explicit retryable:true wins', () => {
    expect(isRetryableError({ retryable: true, status: 400 })).toBe(true);
  });
});

describe('pollTransactionWithRetry — error path', () => {
  it('succeeds on first try without sleeping', async () => {
    const { sleep, delays } = fakeSleep();
    const poll = vi.fn().mockResolvedValue({ status: 'SUCCESS' });
    const result = await pollTransactionWithRetry(
      poll,
      (r) => (r as { status: string }).status === 'SUCCESS',
      opts({ sleep }),
    );
    expect(result).toEqual({ status: 'SUCCESS' });
    expect(delays).toEqual([]);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxRetries, then throws PollRetryExhaustedError', async () => {
    const { sleep, delays } = fakeSleep();
    const poll = vi.fn().mockRejectedValue({ status: 500 });
    await expect(
      pollTransactionWithRetry(poll, () => true, opts({ sleep, maxRetries: 3, initialDelayMs: 100 })),
    ).rejects.toBeInstanceOf(PollRetryExhaustedError);
    // 3 retries => 3 sleeps, 4 total poll invocations (initial + 3 retries).
    expect(delays.length).toBe(3);
    expect(poll).toHaveBeenCalledTimes(4);
  });

  it('uses the exact backoff schedule initial * factor^n', async () => {
    const { sleep, delays } = fakeSleep();
    const poll = vi.fn().mockRejectedValue({ status: 503 });
    await expect(
      pollTransactionWithRetry(
        poll,
        () => true,
        opts({ sleep, initialDelayMs: 1000, backoffFactor: 1.5, maxRetries: 5 }),
      ),
    ).rejects.toBeInstanceOf(PollRetryExhaustedError);
    // 1000, 1500, 2250, 3375, 5062 -> 5 delays, no jitter (random=0.5 -> jitter 0)
    expect(delays).toEqual([1000, 1500, 2250, 3375, 5063]);
  });

  it('caps each delay at maxDelayMs', async () => {
    const { sleep, delays } = fakeSleep();
    const poll = vi.fn().mockRejectedValue({ status: 500 });
    await expect(
      pollTransactionWithRetry(
        poll,
        () => true,
        opts({ sleep, initialDelayMs: 10_000, backoffFactor: 2, maxDelayMs: 15_000, maxRetries: 3 }),
      ),
    ).rejects.toBeInstanceOf(PollRetryExhaustedError);
    // 10000, 15000 (capped from 20000), 15000 (capped from 40000)
    expect(delays).toEqual([10_000, 15_000, 15_000]);
  });

  it('does not retry non-retryable errors (fails fast)', async () => {
    const { sleep, delays } = fakeSleep();
    const poll = vi.fn().mockRejectedValue({ status: 404 });
    await expect(
      pollTransactionWithRetry(poll, () => true, opts({ sleep, maxRetries: 5 })),
    ).rejects.toBeInstanceOf(PollRetryExhaustedError);
    // No sleeps — failed on first attempt.
    expect(delays).toEqual([]);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it('recovers — succeeds after N transient failures', async () => {
    const { sleep, delays } = fakeSleep();
    let calls = 0;
    const poll = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw { status: 503 };
      return { status: 'SUCCESS' };
    });
    const result = await pollTransactionWithRetry(
      poll,
      (r) => (r as { status: string }).status === 'SUCCESS',
      opts({ sleep, initialDelayMs: 100, backoffFactor: 2, maxRetries: 5 }),
    );
    expect(result).toEqual({ status: 'SUCCESS' });
    expect(delays).toEqual([100, 200]);
    expect(calls).toBe(3);
  });
});

describe('pollTransactionWithRetry — Retry-After header', () => {
  it('uses Retry-After seconds when present', async () => {
    const { sleep, delays } = fakeSleep();
    let calls = 0;
    const poll = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw { status: 429, headers: { 'retry-after': '3' } };
      }
      return { status: 'SUCCESS' };
    });
    await pollTransactionWithRetry(
      poll,
      (r) => (r as { status: string }).status === 'SUCCESS',
      opts({ sleep, initialDelayMs: 100 }),
    );
    // Retry-After: 3 (seconds) -> 3000ms, overriding computed 100ms.
    expect(delays).toEqual([3000]);
  });

  it('uses retryAfterMs field when present', async () => {
    const { sleep, delays } = fakeSleep();
    let calls = 0;
    const poll = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw { status: 429, retryAfterMs: 750 };
      return { status: 'SUCCESS' };
    });
    await pollTransactionWithRetry(
      poll,
      (r) => (r as { status: string }).status === 'SUCCESS',
      opts({ sleep }),
    );
    expect(delays).toEqual([750]);
  });

  it('honours Retry-After via Headers-like get()', async () => {
    const { sleep, delays } = fakeSleep();
    let calls = 0;
    const poll = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        const headers = { get: (k: string) => (k.toLowerCase() === 'retry-after' ? '2' : null) };
        throw { status: 429, headers };
      }
      return { status: 'SUCCESS' };
    });
    await pollTransactionWithRetry(
      poll,
      (r) => (r as { status: string }).status === 'SUCCESS',
      opts({ sleep }),
    );
    expect(delays).toEqual([2000]);
  });

  it('caps Retry-After at maxDelayMs', async () => {
    const { sleep, delays } = fakeSleep();
    let calls = 0;
    const poll = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw { status: 429, retryAfterMs: 999_999 };
      return { status: 'SUCCESS' };
    });
    await pollTransactionWithRetry(
      poll,
      (r) => (r as { status: string }).status === 'SUCCESS',
      opts({ sleep, maxDelayMs: 5000 }),
    );
    expect(delays).toEqual([5000]);
  });
});

describe('pollTransactionWithRetry — onRetry observer', () => {
  it('invokes onRetry once per retry with the correct delay', async () => {
    const { sleep } = fakeSleep();
    const events: { attempt: number; delayMs: number }[] = [];
    let calls = 0;
    const poll = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw { status: 503 };
      return { status: 'SUCCESS' };
    });
    await pollTransactionWithRetry(
      poll,
      (r) => (r as { status: string }).status === 'SUCCESS',
      opts({
        sleep,
        initialDelayMs: 1000,
        backoffFactor: 1.5,
        maxRetries: 5,
        onRetry: (info) => events.push({ attempt: info.attempt, delayMs: info.delayMs }),
      }),
    );
    expect(events).toEqual([
      { attempt: 1, delayMs: 1000 },
      { attempt: 2, delayMs: 1500 },
    ]);
  });
});

describe('pollUntil — retries on "not done yet" as well as errors', () => {
  it('retries on a resolved-but-not-done result', async () => {
    const { sleep, delays } = fakeSleep();
    let calls = 0;
    const poll = vi.fn(async () => {
      calls += 1;
      return { status: calls < 3 ? 'NOT_FOUND' : 'SUCCESS' };
    });
    const result = await pollUntil(
      poll,
      (r) => (r as { status: string }).status === 'SUCCESS',
      opts({ sleep, initialDelayMs: 100, backoffFactor: 2, maxRetries: 5 }),
    );
    expect(result).toEqual({ status: 'SUCCESS' });
    expect(delays).toEqual([100, 200]);
  });

  it('throws when maxRetries exhausted on not-done', async () => {
    const { sleep, delays } = fakeSleep();
    const poll = vi.fn().mockResolvedValue({ status: 'NOT_FOUND' });
    await expect(
      pollUntil(poll, () => false, opts({ sleep, initialDelayMs: 100, maxRetries: 2 })),
    ).rejects.toBeInstanceOf(PollRetryExhaustedError);
    expect(delays.length).toBe(2);
  });

  it('also retries on thrown transient errors', async () => {
    const { sleep, delays } = fakeSleep();
    let calls = 0;
    const poll = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw { status: 503 };
      return { status: calls < 3 ? 'NOT_FOUND' : 'SUCCESS' };
    });
    const result = await pollUntil(
      poll,
      (r) => (r as { status: string }).status === 'SUCCESS',
      opts({ sleep, initialDelayMs: 100, backoffFactor: 2, maxRetries: 5 }),
    );
    expect(result).toEqual({ status: 'SUCCESS' });
    expect(delays).toEqual([100, 200]);
  });

  it('propagates non-retryable errors immediately', async () => {
    const { sleep } = fakeSleep();
    const poll = vi.fn().mockRejectedValue({ status: 400 });
    await expect(pollUntil(poll, () => true, opts({ sleep }))).rejects.toBeInstanceOf(
      PollRetryExhaustedError,
    );
    expect(poll).toHaveBeenCalledTimes(1);
  });
});

describe('jitter', () => {
  it('is bounded to ±10% of the computed delay', async () => {
    const { sleep, delays } = fakeSleep();
    const poll = vi.fn().mockRejectedValue({ status: 503 });
    await expect(
      pollTransactionWithRetry(
        poll,
        () => true,
        {
          sleep,
          initialDelayMs: 1000,
          backoffFactor: 1,
          maxRetries: 3,
          random: () => 1, // max jitter
        },
      ),
    ).rejects.toBeInstanceOf(PollRetryExhaustedError);
    // computed = 1000, jitter = 1000 * 0.1 * (1*2 - 1) = 100. delay = 1100.
    expect(delays).toEqual([1100, 1100, 1100]);
  });
});
