/**
 * Exponential-backoff retry helper for Soroban RPC transaction-status polling.
 *
 * Soroban RPC can transiently fail — HTTP 429 rate limits, momentary network
 * partitions, 5xx from a lagging RPC replica — while the transaction itself
 * has already succeeded on-chain. Polling in a naive loop then throws a
 * false-negative error to the caller.
 *
 * This helper retries the poll call with configurable exponential backoff,
 * respects a server-supplied `Retry-After` header when the error carries one,
 * and fails fast on non-retryable errors (e.g. a 404 for an unknown tx).
 *
 * See: https://github.com/LabsCrypt/flowfi/issues/1520
 */

export interface PollRetryOptions {
  /** Delay before the first retry, in ms. Default 1000. */
  initialDelayMs?: number;
  /** Multiplier applied to the delay after each failed attempt. Default 1.5. */
  backoffFactor?: number;
  /** Hard cap on any individual delay, in ms. Default 30_000. */
  maxDelayMs?: number;
  /** Maximum retries (not counting the initial attempt). Default 5. */
  maxRetries?: number;
  /**
   * Predicate that decides whether an error is worth retrying.
   * Defaults to {@link isRetryableError} — retries network failures, 429, and 5xx.
   */
  retryOn?: (error: unknown) => boolean;
  /** Observer invoked before each retry sleep. Useful for logging/metrics. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** Injectable sleep — tests override this to avoid real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock — tests override this to make jitter deterministic. */
  random?: () => number;
}

/**
 * Error surfaced when all retries are exhausted. Carries the last underlying
 * error so callers can inspect the real cause.
 */
export class PollRetryExhaustedError extends Error {
  readonly attempts: number;
  readonly lastError: unknown;
  constructor(attempts: number, lastError: unknown) {
    super(
      `pollTransactionWithRetry: exhausted ${attempts} attempts; last error: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
    this.name = 'PollRetryExhaustedError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * The error shape we understand when a caller wants a server-supplied
 * `Retry-After` to override our computed backoff. Any error exposing a
 * `retryAfterMs` field (a number, or a `Retry-After` header value in a
 * `headers`/`response.headers` map) is honoured.
 */
function extractRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as {
    retryAfterMs?: unknown;
    retryAfter?: unknown;
    headers?: Record<string, string> | { get?(k: string): string | null };
    response?: { headers?: Record<string, string> | { get?(k: string): string | null } };
  };
  if (typeof e.retryAfterMs === 'number' && Number.isFinite(e.retryAfterMs)) {
    return Math.max(0, e.retryAfterMs);
  }
  const raw =
    (typeof e.retryAfter === 'string' ? e.retryAfter : undefined) ??
    headerValue(e.headers, 'retry-after') ??
    headerValue(e.response?.headers, 'retry-after');
  if (raw === undefined || raw === null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const asDate = Date.parse(String(raw));
  return Number.isFinite(asDate) ? Math.max(0, asDate - Date.now()) : null;
}

function headerValue(
  headers: Record<string, string> | { get?(k: string): string | null } | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const v = (headers as { get(k: string): string | null }).get(name);
    return v ?? undefined;
  }
  const rec = headers as Record<string, string>;
  const direct = rec[name] ?? rec[name.toLowerCase()] ?? rec[name.toUpperCase()];
  return direct;
}

/**
 * Default retry predicate: retries anything that looks transient.
 *
 * Retries: network failures (fetch TypeError), timeouts (AbortError), HTTP
 * 429, and any 5xx. Fails fast: HTTP 4xx other than 429, contract errors,
 * and anything carrying `retryable === false` explicitly.
 */
export function isRetryableError(error: unknown): boolean {
  if (!error) return false;
  const e = error as {
    retryable?: unknown;
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };
  if (e.retryable === false) return false;
  if (e.retryable === true) return true;

  const status =
    (typeof e.status === 'number' && e.status) ||
    (typeof e.statusCode === 'number' && e.statusCode) ||
    undefined;
  if (status !== undefined) {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    if (status >= 400 && status <= 499) return false;
  }

  const name = typeof e.name === 'string' ? e.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') return true;

  const code = typeof e.code === 'string' ? e.code : '';
  if (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return true;
  }

  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  if (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('socket hang up') ||
    msg.includes('rate limit')
  ) {
    return true;
  }

  return false;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Retry `poll()` until `isDone()` returns true, or retries are exhausted.
 *
 * The **poll function itself** is retried — the caller passes a function
 * that fetches status once. Retries happen on **thrown errors**, not on
 * "not done yet". A `poll()` that resolves with `isDone() === false` is a
 * normal "not yet included" — the helper returns the resolved value to the
 * caller as-is, no delay, no retry. Retry-with-backoff is for the error case.
 *
 * @example
 * ```ts
 * const status = await pollTransactionWithRetry(
 *   () => server.getTransaction(txHash),
 *   (s) => s.status === 'SUCCESS' || s.status === 'FAILED',
 *   { initialDelayMs: 1000, backoffFactor: 1.5, maxRetries: 5 },
 * );
 * ```
 */
export async function pollTransactionWithRetry<T>(
  poll: () => Promise<T>,
  isDone: (result: T) => boolean,
  options: PollRetryOptions = {},
): Promise<T> {
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const backoffFactor = options.backoffFactor ?? 1.5;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const maxRetries = options.maxRetries ?? 5;
  const retryOn = options.retryOn ?? isRetryableError;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  if (initialDelayMs < 0) throw new Error('initialDelayMs must be >= 0');
  if (backoffFactor < 1) throw new Error('backoffFactor must be >= 1');
  if (maxRetries < 0) throw new Error('maxRetries must be >= 0');

  let attempt = 0;
  for (;;) {
    try {
      const result = await poll();
      if (isDone(result)) return result;
      // Not-done is normal; there is nothing to retry yet.
      // Caller is expected to call again; this helper only retries errors.
      return result;
    } catch (error) {
      if (attempt >= maxRetries || !retryOn(error)) {
        throw new PollRetryExhaustedError(attempt + 1, error);
      }
      // Computed backoff for this attempt (0-indexed: attempt=0 -> initial).
      const computed = Math.min(initialDelayMs * Math.pow(backoffFactor, attempt), maxDelayMs);
      // Jitter: ±10% of the computed delay, so concurrent pollers de-sync.
      const jitter = computed * 0.1 * (random() * 2 - 1);
      let delayMs = Math.max(0, Math.round(computed + jitter));
      const retryAfterMs = extractRetryAfterMs(error);
      if (retryAfterMs !== null) {
        delayMs = Math.min(retryAfterMs, maxDelayMs);
      }
      options.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
      attempt += 1;
    }
  }
}

/**
 * Poll a "not-yet-included" status until `isDone()` is true — i.e. retries
 * on both thrown errors **and** on a resolved-but-not-done result.
 *
 * Use this when the RPC returns `{ status: 'NOT_FOUND' }` as a normal
 * response (which it does) rather than throwing. `pollTransactionWithRetry`
 * only retries thrown errors; this one retries either form.
 */
export async function pollUntil<T>(
  poll: () => Promise<T>,
  isDone: (result: T) => boolean,
  options: PollRetryOptions = {},
): Promise<T> {
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const backoffFactor = options.backoffFactor ?? 1.5;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const maxRetries = options.maxRetries ?? 5;
  const retryOn = options.retryOn ?? isRetryableError;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let attempt = 0;
  let lastError: unknown = undefined;
  for (;;) {
    try {
      const result = await poll();
      if (isDone(result)) return result;
      if (attempt >= maxRetries) {
        throw new PollRetryExhaustedError(attempt + 1, new Error('pollUntil: not done within maxRetries'));
      }
      lastError = undefined;
    } catch (error) {
      if (!retryOn(error)) throw new PollRetryExhaustedError(attempt + 1, error);
      if (attempt >= maxRetries) throw new PollRetryExhaustedError(attempt + 1, error);
      lastError = error;
    }
    const computed = Math.min(initialDelayMs * Math.pow(backoffFactor, attempt), maxDelayMs);
    const jitter = computed * 0.1 * (random() * 2 - 1);
    let delayMs = Math.max(0, Math.round(computed + jitter));
    const retryAfterMs = extractRetryAfterMs(lastError);
    if (retryAfterMs !== null) delayMs = Math.min(retryAfterMs, maxDelayMs);
    options.onRetry?.({ attempt: attempt + 1, delayMs, error: lastError });
    await sleep(delayMs);
    attempt += 1;
  }
}
