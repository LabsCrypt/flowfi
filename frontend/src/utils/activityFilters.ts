import type { BackendStreamEvent, StreamEventType } from "@/lib/api-types";

/**
 * Pure filtering/sorting helpers for the activity history table (issue #1328).
 *
 * Kept UI-free so the multi-parameter filter logic can be unit-tested without
 * a DOM and reused by both the dashboard widget and the full activity page.
 */

export interface ActivityFilters {
  /** Event types to keep. `null`/empty means "all types". */
  types?: StreamEventType[] | null;
  /** Case-insensitive substring match against tx hash or stream id. */
  search?: string;
  /** Inclusive lower bound, unix seconds. */
  fromTimestamp?: number | null;
  /** Inclusive upper bound, unix seconds. */
  toTimestamp?: number | null;
}

export type ActivitySortKey = "timestamp" | "amount" | "streamId";
export type SortDirection = "asc" | "desc";

function matchesSearch(event: BackendStreamEvent, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  return (
    event.transactionHash.toLowerCase().includes(q) ||
    String(event.streamId).includes(q)
  );
}

/** Apply every provided filter. Filters left undefined are ignored. */
export function filterActivityEvents(
  events: BackendStreamEvent[],
  filters: ActivityFilters = {},
): BackendStreamEvent[] {
  const typeSet =
    filters.types && filters.types.length > 0 ? new Set(filters.types) : null;

  return events.filter((event) => {
    if (typeSet && !typeSet.has(event.eventType)) return false;
    if (
      filters.fromTimestamp != null &&
      event.timestamp < filters.fromTimestamp
    ) {
      return false;
    }
    if (filters.toTimestamp != null && event.timestamp > filters.toTimestamp) {
      return false;
    }
    if (filters.search != null && !matchesSearch(event, filters.search)) {
      return false;
    }
    return true;
  });
}

function sortValue(event: BackendStreamEvent, key: ActivitySortKey): bigint {
  switch (key) {
    case "amount":
      return event.amount ? BigInt(event.amount) : 0n;
    case "streamId":
      return BigInt(event.streamId);
    case "timestamp":
    default:
      return BigInt(event.timestamp);
  }
}

/**
 * Return a new array sorted by `key`. Stable for equal keys (preserves the
 * caller's incoming order), so a resort does not reshuffle ties.
 */
export function sortActivityEvents(
  events: BackendStreamEvent[],
  key: ActivitySortKey,
  direction: SortDirection = "desc",
): BackendStreamEvent[] {
  const factor = direction === "asc" ? 1n : -1n;
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const delta = (sortValue(a.event, key) - sortValue(b.event, key)) * factor;
      if (delta > 0n) return 1;
      if (delta < 0n) return -1;
      return a.index - b.index;
    })
    .map(({ event }) => event);
}
