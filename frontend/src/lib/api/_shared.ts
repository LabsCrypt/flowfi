const DEFAULT_API_BASE_URL = "http://localhost:3001";

export const STROOPS_DIVISOR = 1e7;

export function getApiBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

export function toTokenAmount(raw: string): number {
  return Number.parseFloat(raw) / STROOPS_DIVISOR;
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
