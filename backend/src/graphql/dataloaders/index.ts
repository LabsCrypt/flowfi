import DataLoader from "dataloader";
import { prisma } from "../../lib/prisma.js";
import type { Stream, StreamEvent } from "../../generated/prisma/index.js";

/**
 * GraphQL DataLoader layer.
 *
 * The `Stream` type is intentionally relational — a dashboard query selects
 * many streams and, for each, its events, token metadata and positions. Naively
 * resolving those fields issues one query per stream (the classic N+1) plus one
 * more per event relationship. Each loader below collapses a batch of individual
 * field lookups into a single indexed `WHERE ... IN (...)` query per request.
 *
 * Loaders must be created **per request** (see `createDataloaders`) so that
 * results are never shared across users or stale across mutations.
 */

// ─── Token metadata ───────────────────────────────────────────────────────────

export interface TokenMetadata {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  iconUrl: string | null;
}

/**
 * In-memory token registry. Token metadata has no relational home in Postgres
 * (it is chain-derived, not user data), so it is cached here. `registerToken`
 * lets an indexer/cold-start seed warm the cache; `resetTokenRegistry` keeps
 * tests hermetic.
 */
const tokenRegistry = new Map<string, TokenMetadata>();

/** Default Stellar classic asset precision. */
const DEFAULT_DECIMALS = 7;

export function registerToken(metadata: TokenMetadata): void {
  tokenRegistry.set(metadata.address, metadata);
}

export function resetTokenRegistry(): void {
  tokenRegistry.clear();
}

/**
 * Builds a stable fallback for an address the registry does not know about, so
 * a stream never renders with a null token. Contract addresses (C...) are
 * on-chain tokens; the symbol is unknown until an indexer warms the registry.
 */
function synthesizeToken(address: string): TokenMetadata {
  return {
    address,
    symbol: "UNKNOWN",
    name: "Unknown Token",
    decimals: DEFAULT_DECIMALS,
    iconUrl: null,
  };
}

/** Between-batch memo so repeated addresses never refetch within a request. */
export async function batchTokensByAddresses(
  addresses: readonly string[],
): Promise<Array<TokenMetadata>> {
  return addresses.map(
    (address) => tokenRegistry.get(address) ?? synthesizeToken(address),
  );
}

// ─── Streams ──────────────────────────────────────────────────────────────────

function isNumericId(value: string): boolean {
  return /^\d+$/.test(value);
}

/**
 * Batches stream lookups into a single query.
 *
 * A caller may address a stream either by its internal UUID (`Stream.id`) or by
 * its on-chain `streamId`, so the batch probes both columns in one round trip
 * and maps each input key back to the right row.
 */
export async function batchStreamsByIds(
  ids: readonly string[],
): Promise<Array<Stream | null>> {
  const uuidIds = ids.filter((id) => !isNumericId(id));
  const numericIds = ids.filter(isNumericId).map((id) => BigInt(id));

  const or: Array<Record<string, unknown>> = [];
  if (uuidIds.length > 0) or.push({ id: { in: uuidIds } });
  if (numericIds.length > 0) or.push({ streamId: { in: numericIds } });

  if (or.length === 0) {
    return ids.map(() => null);
  }

  const streams = (await prisma.stream.findMany({ where: { OR: or } })) as Stream[];

  const byUuid = new Map<string, Stream>();
  const byStreamId = new Map<string, Stream>();
  for (const stream of streams) {
    byUuid.set(stream.id, stream);
    byStreamId.set(stream.streamId.toString(), stream);
  }

  return ids.map((id) => byUuid.get(id) ?? byStreamId.get(id) ?? null);
}

// ─── Events ───────────────────────────────────────────────────────────────────

/**
 * Batches `Stream.events` resolution: one query for every stream in the batch,
 * grouped back into per-stream ordered lists.
 */
export async function batchEventsByStreamIds(
  streamIds: readonly string[],
): Promise<Array<StreamEvent[]>> {
  const numeric = streamIds
    .filter(isNumericId)
    .map((id) => BigInt(id));

  if (numeric.length === 0) {
    return streamIds.map(() => []);
  }

  const events = (await prisma.streamEvent.findMany({
    where: { streamId: { in: numeric } },
    orderBy: { timestamp: "desc" },
  })) as StreamEvent[];

  const grouped = new Map<string, StreamEvent[]>();
  for (const event of events) {
    const key = event.streamId.toString();
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(event);
    } else {
      grouped.set(key, [event]);
    }
  }

  return streamIds.map((id) => grouped.get(id) ?? []);
}

// ─── Per-request loader set ───────────────────────────────────────────────────

export interface GraphQLDataloaders {
  streamsById: DataLoader<string, Stream | null>;
  eventsByStreamId: DataLoader<string, StreamEvent[]>;
  tokensByAddress: DataLoader<string, TokenMetadata>;
}

/** Creates a fresh loader set for a single GraphQL request. */
export function createDataloaders(): GraphQLDataloaders {
  return {
    streamsById: new DataLoader<string, Stream | null>(async (ids) =>
      batchStreamsByIds(ids),
    ),
    eventsByStreamId: new DataLoader<string, StreamEvent[]>(async (ids) =>
      batchEventsByStreamIds(ids),
    ),
    tokensByAddress: new DataLoader<string, TokenMetadata>(async (addresses) =>
      batchTokensByAddresses(addresses),
    ),
  };
}
