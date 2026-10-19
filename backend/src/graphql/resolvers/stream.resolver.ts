// Resolver implementations for the GraphQL Stream schema.
//
// These are deliberately framework-agnostic: `schema.ts` wires them into Nexus
// fields, which keeps the data-access logic unit-testable on its own.

import type { Prisma } from "../../generated/prisma/index.js";
import type { GraphQLContext } from "../context.js";
import type { TokenMetadata } from "../dataloaders/index.js";

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

export async function resolveStream(
  ctx: GraphQLContext,
  streamId: number | string,
): Promise<unknown> {
  const id = BigInt(streamId);
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
  if (filter.status) where.isActive = filter.status.toLowerCase() === "active";
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
  const amountSelect = { depositedAmount: true, withdrawnAmount: true } as const;
  const [sent, received, activeSent, activeReceived] = await Promise.all([
    ctx.prisma.stream.findMany({ where: { sender: address }, select: amountSelect }),
    ctx.prisma.stream.findMany({ where: { recipient: address }, select: amountSelect }),
    ctx.prisma.stream.count({ where: { sender: address, isActive: true } }),
    ctx.prisma.stream.count({ where: { recipient: address, isActive: true } }),
  ]);

  const sum = (rows: Array<{ depositedAmount: string; withdrawnAmount: string }>, key: "depositedAmount" | "withdrawnAmount"): bigint =>
    rows.reduce((total, row) => total + BigInt(row[key] || "0"), 0n);

  const all = [...sent, ...received];
  const deposited = sum(all, "depositedAmount");
  const withdrawn = sum(all, "withdrawnAmount");
  const claimable = deposited > withdrawn ? deposited - withdrawn : 0n;

  return {
    totalDeposited: deposited.toString(),
    totalWithdrawn: withdrawn.toString(),
    totalClaimable: claimable.toString(),
    activeStreams: activeSent + activeReceived,
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
