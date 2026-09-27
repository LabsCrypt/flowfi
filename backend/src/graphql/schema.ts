import { GraphQLError, GraphQLScalarType, Kind, type ValueNode } from "graphql";
import { createSchema } from "graphql-yoga";

import { prisma } from "../lib/prisma.js";
import { claimableAmountService } from "../services/claimable.service.js";
import type { GraphQLContext } from "./context.js";
import type { Stream, StreamEvent } from "../generated/prisma/index.js";
import { graphqlPubSub, streamTopic, userTopic } from "./pubsub.js";

// ─── Scalar: BigInt ───────────────────────────────────────────────────────────

/**
 * Soroban `u64` values (stream ids, ledger timestamps) exceed the safe integer
 * range of `Int`, and GraphQL has no 64-bit built-in. They travel as strings.
 */
export const BigIntScalar = new GraphQLScalarType<string | number | bigint, string>({
  name: "BigInt",
  description: "An arbitrary-precision integer serialized as a string.",
  serialize(value) {
    return typeof value === "bigint" ? value.toString() : String(value);
  },
  parseValue(value) {
    return String(value);
  },
  parseLiteral(ast: ValueNode) {
    if (ast.kind === Kind.INT || ast.kind === Kind.STRING) {
      return ast.value;
    }
    // A literal the scalar cannot coerce has to raise rather than resolve to
    // null, which is what the parser contract requires.
    throw new GraphQLError(`BigInt cannot represent a ${ast.kind} literal`);
  },
});

// ─── Derived helpers ──────────────────────────────────────────────────────────

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

export interface StreamFilter {
  sender?: string | null;
  recipient?: string | null;
  tokenAddress?: string | null;
  status?: string | null;
}

export interface Pagination {
  first?: number | null;
  after?: string | null;
}

export interface AccountOverview {
  address: string;
  sentStreams: Stream[];
  receivedStreams: Stream[];
  totalDeposited: string;
  totalWithdrawn: string;
  totalClaimable: string;
  activeStreamCount: number;
}

/** Maps the GraphQL filter onto a Prisma `where` clause. */
export function buildStreamWhere(filter?: StreamFilter | null): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (!filter) return where;

  if (filter.sender) where.sender = filter.sender;
  if (filter.recipient) where.recipient = filter.recipient;
  if (filter.tokenAddress) where.tokenAddress = filter.tokenAddress;

  switch (filter.status) {
    case "ACTIVE":
      where.isActive = true;
      where.isPaused = false;
      break;
    case "PAUSED":
      where.isPaused = true;
      break;
    case "INACTIVE":
    case "COMPLETED":
    case "CANCELLED":
      where.isActive = false;
      break;
    default:
      break;
  }

  return where;
}

/** Relay cursor: opaque base64 of the row offset. */
export function offsetToCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, "utf8").toString("base64");
}

export function cursorToOffset(cursor?: string | null): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const match = /^offset:(\d+)$/.exec(decoded);
    return match ? Number.parseInt(match[1] as string, 10) : 0;
  } catch {
    return 0;
  }
}

function resolvePageSize(first?: number | null): number {
  if (typeof first !== "number" || !Number.isFinite(first) || first <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.trunc(first), MAX_PAGE_SIZE);
}

/** Basic status projection from the persisted active/paused flags. */
function deriveStatus(stream: Stream): string {
  if (stream.isActive) {
    return stream.isPaused ? "PAUSED" : "ACTIVE";
  }
  return "INACTIVE";
}

function claimableFor(stream: Stream): string {
  try {
    return claimableAmountService.getClaimableAmount({
      streamId: stream.streamId,
      ratePerSecond: stream.ratePerSecond,
      depositedAmount: stream.depositedAmount,
      withdrawnAmount: stream.withdrawnAmount,
      startTime: stream.startTime,
      lastUpdateTime: stream.lastUpdateTime,
      isActive: stream.isActive,
      isPaused: stream.isPaused,
      pausedAt: stream.pausedAt,
      totalPausedDuration: stream.totalPausedDuration,
      updatedAt: stream.updatedAt,
    }).claimableAmount;
  } catch {
    return "0";
  }
}

/**
 * Projects the two on-chain position receipts (sender and recipient) that the
 * stream contract mints. The backend does not custody receipts, so they are
 * derived from the mirrored stream row rather than stored.
 */
function positionsFor(stream: Stream): Array<Record<string, unknown>> {
  const endTime = stream.endTime ?? stream.startTime;
  const status = stream.isActive ? "ACTIVE" : "SETTLED";
  const base = {
    streamId: stream.streamId,
    tokenAddress: stream.tokenAddress,
    ratePerSecond: stream.ratePerSecond,
    startTime: stream.startTime,
    endTime,
    isTransferable: false,
    status,
  };
  return [
    { ...base, role: "SENDER", owner: stream.sender },
    { ...base, role: "RECIPIENT", owner: stream.recipient },
  ];
}

function requireMatchingWallet(ctx: GraphQLContext, address: string): void {
  if (ctx.auth && ctx.auth.publicKey !== address) {
    throw new GraphQLError("Not authorized for this wallet", {
      extensions: { code: "FORBIDDEN", http: { status: 403 } },
    });
  }
}

// ─── SDL ──────────────────────────────────────────────────────────────────────

const typeDefs = /* GraphQL */ `
  scalar BigInt

  enum StreamStatus {
    ACTIVE
    PAUSED
    CANCELLED
    COMPLETED
    INACTIVE
  }

  enum PositionRole {
    SENDER
    RECIPIENT
  }

  enum PositionStatus {
    ACTIVE
    SETTLED
  }

  type Token {
    address: String!
    symbol: String!
    name: String!
    decimals: Int!
    iconUrl: String
  }

  type StreamPosition {
    streamId: BigInt!
    role: PositionRole!
    owner: String!
    tokenAddress: String!
    ratePerSecond: String!
    startTime: BigInt!
    endTime: BigInt!
    isTransferable: Boolean!
    status: PositionStatus!
  }

  type StreamEvent {
    id: ID!
    streamId: BigInt!
    eventType: String!
    transactionHash: String!
    ledgerSequence: Int!
    timestamp: BigInt!
    amount: String
    metadata: String
  }

  type Stream {
    id: ID!
    streamId: BigInt!
    sender: String!
    recipient: String!
    token: Token!
    tokenAddress: String!
    depositedAmount: String!
    withdrawnAmount: String!
    claimableAmount: String!
    ratePerSecond: String!
    startTime: BigInt!
    endTime: BigInt
    status: StreamStatus!
    events: [StreamEvent!]!
    positions: [StreamPosition!]!
  }

  type AccountOverview {
    address: String!
    sentStreams: [Stream!]!
    receivedStreams: [Stream!]!
    totalDeposited: String!
    totalWithdrawn: String!
    totalClaimable: String!
    activeStreamCount: Int!
  }

  input StreamFilterInput {
    sender: String
    recipient: String
    tokenAddress: String
    status: StreamStatus
  }

  input PaginationInput {
    first: Int
    after: String
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  type StreamEdge {
    cursor: String!
    node: Stream!
  }

  type StreamConnection {
    edges: [StreamEdge!]!
    nodes: [Stream!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type Query {
    stream(id: ID!): Stream
    streams(filter: StreamFilterInput, pagination: PaginationInput): StreamConnection!
    accountOverview(address: String!): AccountOverview!
  }

  type Subscription {
    streamUpdated(streamId: ID!): Stream!
    userStreams(address: String!): StreamEvent!
  }
`;

// ─── Resolvers ────────────────────────────────────────────────────────────────

export const resolvers = {
  BigInt: BigIntScalar,

  Query: {
    stream: (
      _parent: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<Stream | null> => ctx.dataloaders.streamsById.load(args.id),

    streams: async (
      _parent: unknown,
      args: { filter?: StreamFilter; pagination?: Pagination },
      _ctx: GraphQLContext,
    ) => {
      const where = buildStreamWhere(args.filter);
      const limit = resolvePageSize(args.pagination?.first);
      const offset = cursorToOffset(args.pagination?.after);

      const [rows, totalCount] = await Promise.all([
        prisma.stream.findMany({
          where,
          orderBy: { startTime: "desc" },
          take: limit,
          skip: offset,
        }),
        prisma.stream.count({ where }),
      ]);

      const edges = rows.map((node, index) => ({
        cursor: offsetToCursor(offset + index),
        node,
      }));

      return {
        edges,
        nodes: rows,
        pageInfo: {
          hasNextPage: offset + rows.length < totalCount,
          hasPreviousPage: offset > 0,
          startCursor: edges[0]?.cursor ?? null,
          endCursor: edges[edges.length - 1]?.cursor ?? null,
        },
        totalCount,
      };
    },

    accountOverview: async (
      _parent: unknown,
      args: { address: string },
      _ctx: GraphQLContext,
    ): Promise<AccountOverview> => {
      const { address } = args;
      const [sentStreams, receivedStreams] = await Promise.all([
        prisma.stream.findMany({
          where: { sender: address },
          orderBy: { startTime: "desc" },
        }),
        prisma.stream.findMany({
          where: { recipient: address },
          orderBy: { startTime: "desc" },
        }),
      ]);

      const all = [...sentStreams, ...receivedStreams];
      let totalDeposited = 0n;
      let totalWithdrawn = 0n;
      let totalClaimable = 0n;
      let activeStreamCount = 0;

      for (const stream of all) {
        totalDeposited += BigInt(stream.depositedAmount || "0");
        totalWithdrawn += BigInt(stream.withdrawnAmount || "0");
        totalClaimable += BigInt(claimableFor(stream));
        if (stream.isActive) activeStreamCount += 1;
      }

      return {
        address,
        sentStreams,
        receivedStreams,
        totalDeposited: totalDeposited.toString(),
        totalWithdrawn: totalWithdrawn.toString(),
        totalClaimable: totalClaimable.toString(),
        activeStreamCount,
      };
    },
  },

  Stream: {
    streamId: (stream: Stream) => stream.streamId.toString(),
    startTime: (stream: Stream) => stream.startTime.toString(),
    endTime: (stream: Stream) => (stream.endTime === null ? null : stream.endTime.toString()),
    token: (stream: Stream, _args: unknown, ctx: GraphQLContext) =>
      ctx.dataloaders.tokensByAddress.load(stream.tokenAddress),
    claimableAmount: (stream: Stream) => claimableFor(stream),
    status: (stream: Stream) => deriveStatus(stream),
    events: (stream: Stream, _args: unknown, ctx: GraphQLContext) =>
      ctx.dataloaders.eventsByStreamId.load(stream.streamId.toString()),
    positions: (stream: Stream) => positionsFor(stream),
  },

  StreamEvent: {
    streamId: (event: StreamEvent) => event.streamId.toString(),
    timestamp: (event: StreamEvent) => event.timestamp.toString(),
  },

  Subscription: {
    streamUpdated: {
      subscribe: (_parent: unknown, args: { streamId: string }) =>
        graphqlPubSub.subscribe(streamTopic(args.streamId)),
      resolve: (
        payload: unknown,
        args: { streamId: string },
        ctx: GraphQLContext,
      ): Stream | Promise<Stream | null> => {
        if (
          payload &&
          typeof payload === "object" &&
          "sender" in payload &&
          "recipient" in payload
        ) {
          return payload as Stream;
        }
        return ctx.dataloaders.streamsById.load(args.streamId);
      },
    },
    userStreams: {
      subscribe: (_parent: unknown, args: { address: string }, ctx: GraphQLContext) => {
        requireMatchingWallet(ctx, args.address);
        return graphqlPubSub.subscribe(userTopic(args.address));
      },
      resolve: (payload: unknown) => payload,
    },
  },
};

export const schema = createSchema({ typeDefs, resolvers });
