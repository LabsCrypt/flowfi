import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withTimeout, TimeoutError } from '../src/lib/with-timeout.js';

/** Let pending promise callbacks and process-level events run (setImmediate is not faked). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the value when the operation settles before the timeout', async () => {
    const op = deferred<string>();
    const result = withTimeout(op.promise, 1000, 'fast op');

    await vi.advanceTimersByTimeAsync(500);
    op.resolve('pong');

    await expect(result).resolves.toBe('pong');
    // The timeout timer was cleared, so nothing is left scheduled.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates the original rejection when the operation fails before the timeout', async () => {
    const op = deferred<string>();
    const result = withTimeout(op.promise, 1000, 'failing op');

    op.reject(new Error('connection refused'));

    await expect(result).rejects.toThrow('connection refused');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with a TimeoutError once the timeout elapses', async () => {
    const result = withTimeout(new Promise<never>(() => undefined), 800, 'redis ping');
    const assertion = expect(result).rejects.toMatchObject({
      name: 'TimeoutError',
      label: 'redis ping',
      timeoutMs: 800,
      message: 'redis ping timed out after 800ms',
    });

    await vi.advanceTimersByTimeAsync(799);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await assertion;
    await expect(result).rejects.toBeInstanceOf(TimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not surface a late rejection as an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const op = deferred<string>();
      const result = withTimeout(op.promise, 100, 'slow op');
      const assertion = expect(result).rejects.toBeInstanceOf(TimeoutError);

      await vi.advanceTimersByTimeAsync(100);
      await assertion;

      // The abandoned operation fails after the caller has already given up.
      op.reject(new Error('late failure'));
      await flush();
      await flush();

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('ignores a late resolution after the timeout', async () => {
    const op = deferred<string>();
    const result = withTimeout(op.promise, 100, 'slow op');
    const assertion = expect(result).rejects.toBeInstanceOf(TimeoutError);

    await vi.advanceTimersByTimeAsync(100);
    op.resolve('too late');

    await assertion;
  });

  it('accepts thenables such as Prisma queries', async () => {
    const thenable: PromiseLike<number> = {
      then: (onFulfilled, onRejected) => Promise.resolve(1).then(onFulfilled, onRejected),
    };

    await expect(withTimeout(thenable, 100)).resolves.toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
