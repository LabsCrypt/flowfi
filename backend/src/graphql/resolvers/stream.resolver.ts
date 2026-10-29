// Resolver implementations for the GraphQL Stream schema.
//
// These are deliberately framework-agnostic: `schema.ts` wires them into Nexus
// fields, which keeps the data-access logic unit-testable on its own.

import type { Prisma } from "../../generated/prisma/index.js";
import type { GraphQLContext } from "../context.js";
import type { TokenMetadata } from "../dataloaders/index.js";
import { claimableAmountService } from "../../services/claimable.service.js";

export interface StreamFilterInput {
  status?: string | null;
  tokenAddress?: string | null;
  sender?: string | null;
  recipient?: string | null;
}

export interface StreamsQueryArgs {
  first?: number | null;
  after?: string | null;
  filter?: StreamFilterInput | null;
}

export interface StreamConnection {
  edges: Array<{ node: unknown; cursor: string }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/** Normalise Prisma's `bigint` values to the string form exposed by GraphQL. */
export function bigintToString(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

function parseCursor(cursor: string | null | undefined): bigint | undefined {
  if (cursor === null || cursor === undefined || cursor === "") return undefined;
  try {
    return BigInt(cursor);
  } catch {
    return undefined;
  }
}

const MAX_U64 = 18446744073709551615n;

export async function resolveStream(
  ctx: GraphQLContext,
  streamId: number | string,
): Promise<unknown> {
  let id: bigint;
  try {
    id = BigInt(streamId);
  } catch {
    throw new Error(`Invalid stream identifier: ${streamId}`);
  }
  if (id < 0n || id > MAX_U64) {
    throw new Error(`Stream identifier out of supported range (0 to 2^64 - 1): ${streamId}`);
  }
  return ctx.loaders.stream.load(id);
}

export async function resolveStreams(
  ctx: GraphQLContext,
  args: StreamsQueryArgs,
): Promise<StreamConnection> {
  const take = args.first ?? 20;
  const after = parseCursor(args.after);
  const filter = args.filter ?? {};

  const where: Prisma.StreamWhereInput = {};
  if (filter.status !== undefined && filter.status !== null) {
    const normalized = filter.status.toLowerCase().trim();
    switch (normalized) {
      case "active":
        where.isActive = true;
        where.isPaused = false;
        break;
      case "paused":
        where.isPaused = true;
        break;
      case "cancelled":
        where.isActive = false;
        where.events = { some: { eventType: "CANCELLED" } };
        break;
      case "completed":
        where.isActive = false;
        where.events = { some: { eventType: "COMPLETED" } };
        break;
      default:
        throw new Error(
          `Invalid status filter: '${filter.status}'. Supported statuses are 'active', 'paused', 'cancelled', 'completed'.`,
        );
    }
  }
  if (filter.tokenAddress) where.tokenAddress = filter.tokenAddress;
  if (filter.sender) where.sender = filter.sender;
  if (filter.recipient) where.recipient = filter.recipient;

  const rows = await ctx.prisma.stream.findMany({
    where,
    take: take + 1,
    orderBy: { streamId: "desc" },
    ...(after !== undefined ? { cursor: { streamId: after }, skip: 1 } : {}),
  });

  const hasNextPage = rows.length > take;
  const page = hasNextPage ? rows.slice(0, take) : rows;

  return {
    edges: page.map((node) => ({ node, cursor: node.streamId.toString() })),
    pageInfo: {
      hasNextPage,
      endCursor: page.length > 0 ? page[page.length - 1]!.streamId.toString() : null,
    },
  };
}

export interface AccountOverview {
  totalDeposited: string;
  totalWithdrawn: string;
  totalClaimable: string;
  activeStreams: number;
}

export async function resolveAccountOverview(
  ctx: GraphQLContext,
  address: string,
): Promise<AccountOverview> {
  // Amounts are persisted as decimal strings (i128 precision), so Prisma's
  // numeric `_sum` aggregate cannot be used; sum them in BigInt here instead.
  // A single OR query returns self-directed streams once, even when both
  // the sender and recipient match the wallet.
  const streams = await ctx.prisma.stream.findMany({
    where: { OR: [{ sender: address }, { recipient: address }] },
    select: {
      streamId: true,
      recipient: true,
      tokenAddress: true,
      depositedAmount: true,
      withdrawnAmount: true,
      ratePerSecond: true,
      startTime: true,
      lastUpdateTime: true,
      isActive: true,
      isPaused: true,
      pausedAt: true,
      totalPausedDuration: true,
    },
  });

  let deposited = 0n;
  let withdrawn = 0n;
  let claimable = 0n;
  let activeStreams = 0;
  const now = Math.floor(Date.now() / 1000);
  for (const stream of streams) {
    deposited += BigInt(stream.depositedAmount);
    withdrawn += BigInt(stream.withdrawnAmount);
    if (stream.isActive) activeStreams++;
    if (stream.recipient === address) {
      claimable += BigInt(claimableAmountService.getClaimableAmount(stream, now).claimableAmount);
    }
  }

  return {
    totalDeposited: deposited.toString(),
    totalWithdrawn: withdrawn.toString(),
    totalClaimable: claimable.toString(),
    activeStreams,
  };
}

export async function resolveStreamEvents(
  ctx: GraphQLContext,
  streamId: bigint,
): Promise<unknown[]> {
  return ctx.loaders.eventsByStream.load(streamId);
}

export async function resolveStreamToken(
  ctx: GraphQLContext,
  tokenAddress: string,
): Promise<TokenMetadata | null> {
  return ctx.loaders.token.load(tokenAddress);
}

/**
 * Position receipts are minted on-chain (soulbound position NFTs). The backend
 * indexer does not persist them yet, so this resolver returns an empty list
 * rather than issuing an unbatched per-stream query.
 */
export async function resolveStreamPositions(): Promise<never[]> {
  return [];
}
