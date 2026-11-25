export interface UserStreamSummary {
  address: string;
  totalStreamsCreated: number;
  totalStreamedOut: string;
  totalStreamedIn: string;
  currentClaimable: string;
  activeOutgoingCount: number;
  activeIncomingCount: number;
}

interface UserSummaryCacheEntry {
  value: UserStreamSummary;
  expiresAtMs: number;
}

export const USER_SUMMARY_CACHE_TTL_MS = 30_000;

const userSummaryCache = new Map<string, UserSummaryCacheEntry>();

export function getUserStreamSummaryCache(
  address: string,
  nowMs: number,
): UserStreamSummary | undefined {
  const cached = userSummaryCache.get(address);
  if (!cached) return undefined;
  if (cached.expiresAtMs <= nowMs) {
    userSummaryCache.delete(address);
    return undefined;
  }
  return cached.value;
}

export function setUserStreamSummaryCache(
  address: string,
  value: UserStreamSummary,
  nowMs: number,
): void {
  userSummaryCache.set(address, {
    value,
    expiresAtMs: nowMs + USER_SUMMARY_CACHE_TTL_MS,
  });
}

export function invalidateUserStreamSummaryCache(...addresses: string[]): void {
  if (addresses.length === 0) {
    userSummaryCache.clear();
    return;
  }
  for (const address of addresses) userSummaryCache.delete(address);
}

export function pruneUserStreamSummaryCache(nowMs: number): void {
  for (const [address, entry] of userSummaryCache.entries()) {
    if (entry.expiresAtMs <= nowMs) userSummaryCache.delete(address);
  }
}

setInterval(() => {
  pruneUserStreamSummaryCache(Date.now());
}, 60_000);
