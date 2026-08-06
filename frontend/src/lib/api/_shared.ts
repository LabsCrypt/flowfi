const DEFAULT_API_BASE_URL = "http://localhost:3001";

export const STROOPS_DIVISOR = 1e7;

/** Default timeout applied by `fetchWithTimeout` when the caller doesn't override it. */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/** Thrown by `fetchWithTimeout` when a request is aborted for exceeding its timeout. */
export class FetchTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "FetchTimeoutError";
  }
}

export function getApiBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

export function toTokenAmount(raw: string): number {
  return Number.parseFloat(raw) / STROOPS_DIVISOR;
}

/**
 * Shared fetch wrapper that aborts the request after `timeoutMs` so a stalled
 * backend or indexer can't hang the caller's loading state indefinitely.
 * Rejects with a `FetchTimeoutError` (a clear, user-presentable message) when
 * the timeout fires instead of the browser's generic abort error.
 */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new FetchTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function getStreamsEndpointCandidates(): string[] {
  const baseUrl = getApiBaseUrl();
  const candidates = new Set<string>();

  if (baseUrl.endsWith("/api/v1") || baseUrl.endsWith("/v1")) {
    candidates.add(`${baseUrl}/streams`);
  } else if (baseUrl.endsWith("/api")) {
    candidates.add(`${baseUrl}/v1/streams`);
    candidates.add(`${baseUrl.replace(/\/api$/, "")}/v1/streams`);
  } else {
    candidates.add(`${baseUrl}/api/v1/streams`);
    candidates.add(`${baseUrl}/v1/streams`);
  }

  return [...candidates];
}
