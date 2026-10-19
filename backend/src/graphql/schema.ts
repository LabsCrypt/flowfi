// Nexus schema for the FlowFi GraphQL API.
//
// Types mirror the Prisma data model (see `backend/prisma/schema.prisma`); the
// actual data access lives in `resolvers/stream.resolver.ts` so the schema stays
// declarative.

import {
  inputObjectType,
  intArg,
  makeSchema,
  nonNull,
  objectType,
  queryType,
  stringArg,
  subscriptionType,
} from "nexus";
import type { GraphQLContext } from "./context.js";
import {
  resolveAccountOverview,
  resolveStream,
  resolveStreamEvents,
  resolveStreamPositions,
  resolveStreamToken,
  resolveStreams,
  type StreamsQueryArgs,
} from "./resolvers/stream.resolver.js";

function asContext(ctx: unknown): GraphQLContext {
  return ctx as GraphQLContext;
}

const Stream = objectType({
  name: "Stream",
  definition(t) {
    t.nonNull.id("id");
    t.nonNull.string("streamId", { resolve: (source: any) => source.streamId.toString() });
    t.nonNull.string("sender");
    t.nonNull.string("recipient");
    t.nonNull.string("tokenAddress");
    t.nonNull.string("ratePerSecond");
    t.nonNull.string("depositedAmount");
    t.nonNull.string("withdrawnAmount");
    t.nonNull.string("startTime", { resolve: (source: any) => source.startTime.toString() });
    t.string("endTime", {
      resolve: (source: any) => (source.endTime == null ? null : source.endTime.toString()),
    });
    t.nonNull.boolean("isActive");
    t.nonNull.boolean("isPaused");
    t.field("token", {
      type: "Token",
      resolve: (source: any, _args: any, ctx: any) =>
        resolveStreamToken(asContext(ctx), source.tokenAddress),
    });
    t.nonNull.list.nonNull.field("events", {
      type: "StreamEvent",
      resolve: (source: any, _args: any, ctx: any) =>
        resolveStreamEvents(asContext(ctx), source.streamId),
    });
    t.nonNull.list.nonNull.field("positions", {
      type: "Position",
      resolve: () => resolveStreamPositions(),
    });
  },
});

const StreamEvent = objectType({
  name: "StreamEvent",
  definition(t) {
    t.nonNull.id("id");
    t.nonNull.string("streamId", { resolve: (source: any) => source.streamId.toString() });
    t.nonNull.string("eventType");
    t.string("amount");
    t.nonNull.string("transactionHash");
    t.nonNull.int("ledgerSequence");
    t.nonNull.string("timestamp", { resolve: (source: any) => source.timestamp.toString() });
  },
});

const Token = objectType({
  name: "Token",
  definition(t) {
    t.nonNull.string("address");
    t.nonNull.string("symbol");
    t.nonNull.string("name");
    t.nonNull.int("decimals");
    t.string("iconUrl");
  },
});

const Position = objectType({
  name: "Position",
  definition(t) {
    t.nonNull.string("streamId");
    t.nonNull.string("role");
    t.nonNull.boolean("isTransferable");
  },
});

const PageInfo = objectType({
  name: "PageInfo",
  definition(t) {
    t.nonNull.boolean("hasNextPage");
    t.string("endCursor");
  },
});

const StreamEdge = objectType({
  name: "StreamEdge",
  definition(t) {
    t.nonNull.field("node", { type: "Stream" });
    t.nonNull.string("cursor");
  },
});

const StreamConnection = objectType({
  name: "StreamConnection",
  definition(t) {
    t.nonNull.list.nonNull.field("edges", { type: "StreamEdge" });
    t.nonNull.field("pageInfo", { type: "PageInfo" });
  },
});

const AccountOverview = objectType({
  name: "AccountOverview",
  definition(t) {
    t.nonNull.string("totalDeposited");
    t.nonNull.string("totalWithdrawn");
    t.nonNull.string("totalClaimable");
    t.nonNull.int("activeStreams");
  },
});

const StreamFilterInput = inputObjectType({
  name: "StreamFilterInput",
  definition(t) {
    t.string("status");
    t.string("tokenAddress");
    t.string("sender");
    t.string("recipient");
  },
});

const Query = queryType({
  definition(t) {
    t.field("stream", {
      type: "Stream",
      args: { streamId: nonNull(intArg()) },
      resolve: (_source: any, args: any, ctx: any) =>
        resolveStream(asContext(ctx), args.streamId),
    });
    t.nonNull.field("streams", {
      type: "StreamConnection",
      args: { first: intArg(), after: stringArg(), filter: StreamFilterInput },
      resolve: (_source: any, args: any, ctx: any) =>
        resolveStreams(asContext(ctx), args as StreamsQueryArgs),
    });
    t.nonNull.field("accountOverview", {
      type: "AccountOverview",
      args: { address: nonNull(stringArg()) },
      resolve: (_source: any, args: any, ctx: any) =>
        resolveAccountOverview(asContext(ctx), args.address),
    });
  },
});

const Subscription = subscriptionType({
  definition(t) {
    t.field("streamUpdated", {
      type: "Stream",
      args: { streamId: nonNull(intArg()) },
      subscribe: () => {
        throw new Error("Subscriptions are delivered over the SSE gateway, not HTTP POST.");
      },
      resolve: () => {
        throw new Error("Subscriptions are delivered over the SSE gateway, not HTTP POST.");
      },
    });
    t.field("userStreams", {
      type: "StreamEvent",
      args: { address: nonNull(stringArg()) },
      subscribe: () => {
        throw new Error("Subscriptions are delivered over the SSE gateway, not HTTP POST.");
      },
      resolve: () => {
        throw new Error("Subscriptions are delivered over the SSE gateway, not HTTP POST.");
      },
    });
  },
});

export const schema = makeSchema({
  types: [
    Stream,
    StreamEvent,
    Token,
    Position,
    PageInfo,
    StreamEdge,
    StreamConnection,
    AccountOverview,
    StreamFilterInput,
    Query,
    Subscription,
  ],
  outputs: false,
});
