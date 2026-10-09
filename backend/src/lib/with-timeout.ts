/**
 * Generic promise timeout helper.
 *
 * `withTimeout` races a promise against a timer and rejects with a
 * `TimeoutError` if the timer wins. It only stops *waiting*: the underlying
 * operation keeps running, so callers should still configure their own client
 * timeouts where the library supports them.
 */
export class TimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export async function withTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs: number,
  label = 'operation',
): Promise<T> {
  const pending = Promise.resolve(operation);
  // If the timer wins, `pending` may still reject later. Attach a no-op
  // handler so that late rejection is never reported as unhandled.
  pending.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([pending, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
