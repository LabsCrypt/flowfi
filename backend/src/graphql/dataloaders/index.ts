// DataLoader batching helpers for GraphQL queries.
//
// Each loader collapses the N+1 lookups produced by nested fields into a single
// indexed SQL query per request (e.g. `WHERE streamId IN (...)`), then hands the
// results back to the caller in the exact order the keys were requested.

import DataLoader from "dataloader";
import type { PrismaClient, Stream, StreamEvent, TokenRegistry } from "../../generated/prisma/index.js";

export interface TokenMetadata {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  iconUrl: string | null;
}

export interface DataLoaders {
  stream: DataLoader<bigint, Stream | null>;
  eventsByStream: DataLoader<bigint, StreamEvent[]>;
  token: DataLoader<string, TokenMetadata | null>;
}

/**
 * Batch stream lookups into a single SQL `WHERE streamId IN (...)` query.
 */
export async function batchStreamsByIds(
  prisma: PrismaClient,
  streamIds: readonly bigint[],
): Promise<(Stream | null)[]> {
  const rows = await prisma.stream.findMany({
    where: { streamId: { in: [...streamIds] } },
  });
  const byId = new Map<bigint, Stream>(rows.map((row) => [row.streamId, row]));
  return streamIds.map((id) => byId.get(id) ?? null);
}

/**
 * Group events for multiple streams in a single indexed query, preserving the
 * requested key order.
 */
export async function batchEventsByStreamIds(
  prisma: PrismaClient,
  streamIds: readonly bigint[],
): Promise<StreamEvent[][]> {
  const rows = await prisma.streamEvent.findMany({
    where: { streamId: { in: [...streamIds] } },
    orderBy: { timestamp: "desc" },
  });
  const byStream = new Map<bigint, StreamEvent[]>();
  for (const row of rows) {
    const bucket = byStream.get(row.streamId);
    if (bucket) {
      bucket.push(row);
    } else {
      byStream.set(row.streamId, [row]);
    }
  }
  return streamIds.map((id) => byStream.get(id) ?? []);
}

/**
 * Resolve token metadata for many contract addresses in one query.
 */
export async function batchTokensByAddresses(
  prisma: PrismaClient,
  addresses: readonly string[],
): Promise<(TokenMetadata | null)[]> {
  const rows = await prisma.tokenRegistry.findMany({
    where: { contractAddress: { in: [...addresses] } },
  });
  const byAddress = new Map<string, TokenRegistry>(rows.map((row) => [row.contractAddress, row]));
  return addresses.map((address) => {
    const row = byAddress.get(address);
    return row
      ? {
          address: row.contractAddress,
          symbol: row.symbol,
          name: row.name,
          decimals: row.decimals,
          iconUrl: row.iconUrl,
        }
      : null;
  });
}

/**
 * Create a per-request set of DataLoaders bound to the given Prisma client.
 */
export function createDataLoaders(prisma: PrismaClient): DataLoaders {
  return {
    stream: new DataLoader<bigint, Stream | null>((ids) => batchStreamsByIds(prisma, ids)),
    eventsByStream: new DataLoader<bigint, StreamEvent[]>((ids) =>
      batchEventsByStreamIds(prisma, ids),
    ),
    token: new DataLoader<string, TokenMetadata | null>((addresses) =>
      batchTokensByAddresses(prisma, addresses),
    ),
  };
}
