import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  FetchTimeoutError,
  fetchWithTimeout,
} from './_shared';

describe('fetchWithTimeout non-JSON error responses', () => {
  let originalFetch: typeof global.fetch;
  let fetchMock: Mock;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('passes a JSON success response through untouched', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    });

    const response = await fetchWithTimeout('http://localhost:3001/api/v1/streams');

    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({ data: [] });
  });

  it('resolves with an HTML error page instead of throwing', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      headers: { get: () => 'text/html' },
      text: async () => '<html><body><h1>502 Bad Gateway</h1></body></html>',
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });

    const response = await fetchWithTimeout('http://localhost:3001/api/v1/streams');

    expect(response.ok).toBe(false);
    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toContain('502 Bad Gateway');
  });

  it('resolves with an empty error body the caller can read back', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => '',
      json: async () => {
        throw new SyntaxError('Unexpected end of JSON input');
      },
    });

    const response = await fetchWithTimeout('http://localhost:3001/api/v1/streams');

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe('');
  });

  it('leaves malformed JSON error bodies for the caller to handle', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new SyntaxError('Unexpected token e in JSON at position 1');
      },
    });

    // The wrapper never inspects the body, so the response itself resolves;
    // only the caller's own .json() call rejects.
    const response = await fetchWithTimeout('http://localhost:3001/api/v1/streams');

    expect(response.status).toBe(500);
    await expect(response.json()).rejects.toThrow(SyntaxError);
  });

  it('never throws on a non-2xx status alone', async () => {
    for (const status of [400, 401, 403, 404, 500]) {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status,
        json: async () => ({ error: 'boom' }),
      });

      await expect(fetchWithTimeout('http://localhost:3001/api/v1/streams')).resolves.toMatchObject({
        ok: false,
        status,
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('propagates a fetch-layer dependency failure unchanged', async () => {
    const networkError = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValueOnce(networkError);

    await expect(fetchWithTimeout('http://localhost:3001/api/v1/streams')).rejects.toBe(networkError);
  });
});

describe('fetchWithTimeout abort timer cleanup', () => {
  let originalFetch: typeof global.fetch;
  let fetchMock: Mock;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    vi.clearAllMocks();
  });

  /** A backend that never answers: settles only when the timeout aborts it. */
  const hangUntilAborted = (_url: string, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const abortError = new Error('The operation was aborted.');
        abortError.name = 'AbortError';
        reject(abortError);
      });
    });

  it('clears the timeout timer after a successful response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

    const response = await fetchWithTimeout('http://localhost:3001/api/v1/streams', {}, 1000);

    expect(response.ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    // Nothing is left to fire once the (now irrelevant) deadline passes.
    await vi.advanceTimersByTimeAsync(5000);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal?.aborted).toBe(false);
  });

  it('clears the timeout timer when the request fails', async () => {
    const networkError = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValueOnce(networkError);

    await expect(
      fetchWithTimeout('http://localhost:3001/api/v1/streams', {}, 5000),
    ).rejects.toBe(networkError);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a hung request at the default timeout with a FetchTimeoutError', async () => {
    fetchMock.mockImplementation(hangUntilAborted);

    const pending = fetchWithTimeout('http://localhost:3001/api/v1/streams');
    const assertion = expect(pending).rejects.toThrow(
      `Request timed out after ${DEFAULT_FETCH_TIMEOUT_MS}ms`,
    );

    await vi.advanceTimersByTimeAsync(DEFAULT_FETCH_TIMEOUT_MS);
    await assertion;

    await expect(pending).rejects.toBeInstanceOf(FetchTimeoutError);
    await expect(pending).rejects.toHaveProperty('name', 'FetchTimeoutError');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honours a caller-supplied timeoutMs', async () => {
    fetchMock.mockImplementation(hangUntilAborted);

    const pending = fetchWithTimeout('http://localhost:3001/api/v1/streams', {}, 250);
    const assertion = expect(pending).rejects.toThrow('Request timed out after 250ms');

    await vi.advanceTimersByTimeAsync(250);
    await assertion;
  });

  it('reports a fetch-layer AbortError as a FetchTimeoutError', async () => {
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';
    fetchMock.mockRejectedValueOnce(abortError);

    await expect(
      fetchWithTimeout('http://localhost:3001/api/v1/streams', {}, 5000),
    ).rejects.toBeInstanceOf(FetchTimeoutError);

    expect(vi.getTimerCount()).toBe(0);
  });
});
