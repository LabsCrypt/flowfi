import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { fetchWithTimeout } from './_shared';

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
