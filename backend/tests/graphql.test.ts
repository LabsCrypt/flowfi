import { describe, it, expect, vi, beforeEach } from "vitest";

const prismaMock = vi.hoisted(() => ({
  stream: {
    findMany: vi.fn(),
    count: vi.fn(),
  },
  streamEvent: {
    findMany: vi.fn(),
  },
}));

vi.mock("../src/lib/prisma.js", () => ({
  default: prismaMock,
  prisma: prismaMock,
}));

import { yoga } from "../src/graphql/index.js";
import { buildContext } from "../src/graphql/context.js";
import {
  graphqlPubSub,
  streamTopic,
  userTopic,
} from "../src/graphql/pubsub.js";
import { resolvers } from "../src/graphql/schema.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function streamRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "uuid-1",
    streamId: 1n,
    sender: "GSENDER",
    recipient: "GRECIPIENT",
    tokenAddress: "CTOKEN",
    ratePerSecond: "10",
    depositedAmount: "1000",
    withdrawnAmount: "0",
    startTime: 0n,
    lastUpdateTime: 0n,
    endTime: 100n,
    isActive: true,
    isPaused: false,
    pausedAt: null,
    totalPausedDuration: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    streamId: 1n,
    eventType: "CREATED",
    amount: "1000",
    transactionHash: "tx-1",
    ledgerSequence: 10,
    timestamp: 0n,
    metadata: null,
    createdAt: new Date(),
    ...overrides,
  };
}

async function gql(
  query: string,
  variables?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const response = await yoga.fetch("http://localhost/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ query, variables }),
  });
  return { status: response.status, body: (await response.json()) as any };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.stream.findMany.mockResolvedValue([]);
  prismaMock.stream.count.mockResolvedValue(0);
  prismaMock.streamEvent.findMany.mockResolvedValue([]);
});

// ─── Schema & introspection ───────────────────────────────────────────────────

describe("GraphQL schema", () => {
  it("passes introspection and exposes Query/Subscription roots", async () => {
    const { status, body } = await gql(`{
      __schema {
        queryType { name }
        subscriptionType { name }
        types { name }
      }
    }`);

    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data.__schema.queryType.name).toBe("Query");
    expect(body.data.__schema.subscriptionType.name).toBe("Subscription");
    const typeNames = body.data.__schema.types.map((t: { name: string }) => t.name);
    expect(typeNames).toEqual(
      expect.arrayContaining(["Stream", "Token", "StreamEvent", "StreamConnection"]),
    );
  });

  it("formats validation errors as a GraphQL errors array with a path-free message", async () => {
    const { body } = await gql(`{ thisFieldDoesNotExist }`);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors[0].message).toMatch(/thisFieldDoesNotExist/);
  });
});

// ─── Queries & DataLoaders ────────────────────────────────────────────────────

describe("stream queries", () => {
  it("resolves stream(id) through the streams DataLoader", async () => {
    prismaMock.stream.findMany.mockResolvedValue([streamRow()]);

    const { body } = await gql(`{
      stream(id: "1") {
        id
        streamId
        sender
        recipient
        claimableAmount
        token { address decimals }
        positions { role owner status }
      }
    }`);

    expect(body.errors).toBeUndefined();
    expect(body.data.stream.streamId).toBe("1");
    expect(body.data.stream.token.address).toBe("CTOKEN");
    expect(body.data.stream.positions).toHaveLength(2);
    expect(body.data.stream.positions[0].role).toBe("SENDER");
  });

  it("batches nested stream->events lookups into a single query", async () => {
    prismaMock.stream.findMany.mockResolvedValue([
      streamRow({ id: "a", streamId: 1n }),
      streamRow({ id: "b", streamId: 2n }),
      streamRow({ id: "c", streamId: 3n }),
    ]);
    prismaMock.streamEvent.findMany.mockResolvedValue([
      eventRow({ id: "e1", streamId: 1n }),
      eventRow({ id: "e2", streamId: 2n }),
      eventRow({ id: "e3", streamId: 3n }),
    ]);

    const { body } = await gql(`{
      streams {
        nodes {
          id
          events { id eventType }
        }
      }
    }`);

    expect(body.errors).toBeUndefined();
    // One event query for all three streams — the N+1 is gone.
    expect(prismaMock.streamEvent.findMany).toHaveBeenCalledTimes(1);
    expect(body.data.streams.nodes).toHaveLength(3);
    expect(body.data.streams.nodes[0].events[0].id).toBe("e1");
  });

  it("returns a Relay connection with cursors and pageInfo", async () => {
    prismaMock.stream.findMany.mockResolvedValue([
      streamRow({ id: "a", streamId: 1n }),
      streamRow({ id: "b", streamId: 2n }),
    ]);
    prismaMock.stream.count.mockResolvedValue(5);

    const { body } = await gql(
      `query Q($p: PaginationInput) {
        streams(pagination: $p) {
          edges { cursor node { id } }
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
          totalCount
        }
      }`,
      { p: { first: 2, after: Buffer.from("offset:0").toString("base64") } },
    );

    expect(body.errors).toBeUndefined();
    const connection = body.data.streams;
    expect(connection.edges).toHaveLength(2);
    expect(connection.pageInfo.hasNextPage).toBe(true);
    expect(connection.pageInfo.hasPreviousPage).toBe(false);
    expect(connection.pageInfo.startCursor).toBe(connection.edges[0].cursor);
    expect(connection.totalCount).toBe(5);
  });

  it("translates a status filter into the Prisma where clause", async () => {
    prismaMock.stream.findMany.mockResolvedValue([]);
    prismaMock.stream.count.mockResolvedValue(0);

    const { body } = await gql(
      `query Q($f: StreamFilterInput) { streams(filter: $f) { totalCount } }`,
      { f: { status: "ACTIVE", recipient: "GRECIPIENT" } },
    );

    expect(body.errors).toBeUndefined();
    const call = prismaMock.stream.findMany.mock.calls[0]![0];
    expect(call.where).toMatchObject({
      recipient: "GRECIPIENT",
      isActive: true,
      isPaused: false,
    });
  });

  it("aggregates wallet overview across sent and received streams", async () => {
    prismaMock.stream.findMany
      .mockResolvedValueOnce([streamRow({ id: "s1", depositedAmount: "1000" })])
      .mockResolvedValueOnce([
        streamRow({ id: "r1", depositedAmount: "500", withdrawnAmount: "100" }),
      ]);

    const { body } = await gql(`{
      accountOverview(address: "GWALLET") {
        address
        totalDeposited
        totalWithdrawn
        activeStreamCount
        sentStreams { id }
        receivedStreams { id }
      }
    }`);

    expect(body.errors).toBeUndefined();
    expect(body.data.accountOverview.totalDeposited).toBe("1500");
    expect(body.data.accountOverview.totalWithdrawn).toBe("100");
    expect(body.data.accountOverview.activeStreamCount).toBe(2);
  });
});

// ─── Subscriptions ────────────────────────────────────────────────────────────

describe("GraphQL subscriptions", () => {
  it("delivers published stream snapshots through streamUpdated", async () => {
    const context = buildContext({ request: new Request("http://localhost/graphql") });
    const subscribe = resolvers.Subscription.streamUpdated.subscribe as (
      parent: unknown,
      args: { streamId: string },
      ctx: unknown,
    ) => AsyncIterableIterator<unknown>;

    const iterator = subscribe(null, { streamId: "7" }, context);
    const row = streamRow({ id: "uuid-7", streamId: 7n });

    graphqlPubSub.publish(streamTopic("7"), row);
    const { value } = await iterator.next();

    expect(value).toMatchObject({ streamId: 7n, sender: "GSENDER" });
    await iterator.return?.();
  });

  it("routes user-scoped events through userStreams", async () => {
    const context = buildContext({ request: new Request("http://localhost/graphql") });
    const subscribe = resolvers.Subscription.userStreams.subscribe as (
      parent: unknown,
      args: { address: string },
      ctx: unknown,
    ) => AsyncIterableIterator<unknown>;

    const address = "GWALLET";
    const event = eventRow();
    const iterator = subscribe(null, { address }, context);

    graphqlPubSub.publish(userTopic(address), event);
    const { value } = await iterator.next();

    expect(value).toMatchObject({ id: "event-1", eventType: "CREATED" });
    await iterator.return?.();
  });

  it("exposes subscriptions over the SSE transport", async () => {
    const response = await yoga.fetch("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        query: `subscription { streamUpdated(streamId: "9") { id } }`,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    // The subscription stays open until the client disconnects; releasing the
    // lock here is enough for the assertion and avoids racing yoga's SSE
    // teardown inside a synchronous test.
    response.body?.getReader().releaseLock();
  });

  it("rejects a userStreams subscription for a different authenticated wallet", () => {
    const context = buildContext({
      request: new Request("http://localhost/graphql", {
        headers: { authorization: "Bearer not-a-real-token" },
      }),
    });
    // An unverifiable token yields an anonymous context, so forge an auth
    // mismatch directly to exercise the authorization guard.
    const mismatched = { ...context, auth: { publicKey: "GOTHER" } };
    const subscribe = resolvers.Subscription.userStreams.subscribe as (
      parent: unknown,
      args: { address: string },
      ctx: unknown,
    ) => unknown;

    expect(() => subscribe(null, { address: "GWALLET" }, mismatched)).toThrowError(
      /Not authorized/,
    );
  });
});
