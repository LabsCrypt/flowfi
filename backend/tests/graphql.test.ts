import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    stream: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    streamEvent: {
      findMany: vi.fn(),
    },
    tokenRegistry: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

vi.mock("../src/lib/redis.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/redis.js")>()),
  getPublisher: vi.fn(() => null),
}));

vi.mock("../src/workers/soroban-event-worker.js", () => ({
  sorobanEventWorker: {
    getEventCounters: vi.fn().mockReturnValue({
      eventsProcessed: 0,
      eventsFailed: 0,
      lastErrorAt: null,
      degraded: false,
    }),
  },
  SorobanEventWorker: vi.fn(),
}));

vi.mock("../src/services/sorobanService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/sorobanService.js")>()),
  checkRpcHealth: vi.fn(async () => true),
  getLatestLedger: vi.fn(async () => 0),
}));

import app from "../src/app.js";

const ADDRESS = "GABCDEF1234567890ABCDEF1234567890ABCDEF12345678";
const NOW = 1_700_000_000;

function stream(overrides = {}) {
  return {
    streamId: 1n,
    sender: "G-OTHER",
    recipient: ADDRESS,
    tokenAddress: "TOKEN_A",
    depositedAmount: "1000",
    withdrawnAmount: "0",
    ratePerSecond: "10",
    startTime: BigInt(NOW - 10),
    lastUpdateTime: BigInt(NOW - 10),
    isActive: true,
    isPaused: false,
    pausedAt: null,
    totalPausedDuration: 0,
    ...overrides,
  };
}

describe("GraphQL API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Account-overview queries select the amount columns; list queries do not.
    prismaMock.stream.findMany.mockImplementation(async (args: { select?: unknown }) =>
      args && args.select ? [stream({ depositedAmount: "100", withdrawnAmount: "25", isActive: false })] : [],
    );
    prismaMock.streamEvent.findMany.mockResolvedValue([]);
    prismaMock.tokenRegistry.findMany.mockResolvedValue([]);
    prismaMock.stream.count.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes introspection queries and validates schema against TypeScript types", async () => {
    const response = await request(app)
      .post("/graphql")
      .send({ query: "{ __schema { types { name } } }" });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("data.__schema");
    expect(Array.isArray(response.body.data.__schema.types)).toBe(true);
  });

  it("validates schema against Stream type", async () => {
    const response = await request(app)
      .post("/graphql")
      .send({
        query: `
          query {
            __type(name: "Stream") {
              name
              fields {
                name
              }
            }
          }
        `,
      });

    expect(response.status).toBe(200);
    expect(response.body.data.__type.name).toBe("Stream");
  });

  it("supports stream query with valid stream ID", async () => {
    const response = await request(app)
      .post("/graphql")
      .send({
        query: 'query { stream(streamId: "1") { id streamId sender recipient } }',
      });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.stream).toBeNull();
  });

  it("supports streams query with pagination", async () => {
    const response = await request(app)
      .post("/graphql")
      .send({
        query: `
          query {
            streams(first: 10) {
              edges { node { id streamId } }
              pageInfo { hasNextPage endCursor }
            }
          }
        `,
      });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.streams.edges).toEqual([]);
    expect(response.body.data.streams.pageInfo.hasNextPage).toBe(false);
  });

  it("supports accountOverview query", async () => {
    const response = await request(app)
      .post("/graphql")
      .send({
        query:
          'query { accountOverview(address: "GABCDEF1234567890ABCDEF1234567890ABCDEF12345678") { totalDeposited totalWithdrawn activeStreams } }',
      });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.accountOverview.totalDeposited).toBe("100");
    expect(response.body.data.accountOverview.activeStreams).toBe(0);
  });

  it.each([
    {
      name: "outgoing-only wallet",
      rows: [stream({ sender: ADDRESS, recipient: "G-OTHER", withdrawnAmount: "25" })],
      expected: { totalDeposited: "1000", totalWithdrawn: "25", totalClaimable: "0", activeStreams: 1 },
    },
    {
      name: "unvested incoming stream",
      rows: [stream({ startTime: BigInt(NOW + 60), lastUpdateTime: BigInt(NOW + 60) })],
      expected: { totalDeposited: "1000", totalWithdrawn: "0", totalClaimable: "0", activeStreams: 1 },
    },
    {
      name: "partially accrued incoming stream",
      rows: [stream({ lastUpdateTime: BigInt(NOW - 30), withdrawnAmount: "100" })],
      expected: { totalDeposited: "1000", totalWithdrawn: "100", totalClaimable: "300", activeStreams: 1 },
    },
    {
      name: "self-directed stream counted once",
      rows: [stream({ sender: ADDRESS, withdrawnAmount: "20" })],
      expected: { totalDeposited: "1000", totalWithdrawn: "20", totalClaimable: "100", activeStreams: 1 },
    },
    {
      name: "paused incoming stream frozen at pause time",
      rows: [stream({ isPaused: true, pausedAt: BigInt(NOW - 6) })],
      expected: { totalDeposited: "1000", totalWithdrawn: "0", totalClaimable: "40", activeStreams: 1 },
    },
    {
      name: "inactive incoming stream",
      rows: [stream({ isActive: false, withdrawnAmount: "20" })],
      expected: { totalDeposited: "1000", totalWithdrawn: "20", totalClaimable: "0", activeStreams: 0 },
    },
    {
      name: "claimable capped by the remaining deposit",
      rows: [stream({ withdrawnAmount: "975" })],
      expected: { totalDeposited: "1000", totalWithdrawn: "975", totalClaimable: "25", activeStreams: 1 },
    },
    {
      name: "mixed directions and states",
      rows: [
        stream({ sender: ADDRESS, withdrawnAmount: "20" }),
        stream({ streamId: 2n, sender: ADDRESS, recipient: "G-OTHER", depositedAmount: "2000", withdrawnAmount: "100" }),
        stream({ streamId: 3n, isPaused: true, pausedAt: BigInt(NOW - 6) }),
        stream({ streamId: 4n, isActive: false, withdrawnAmount: "20" }),
      ],
      expected: { totalDeposited: "5000", totalWithdrawn: "140", totalClaimable: "140", activeStreams: 3 },
    },
    {
      name: "empty wallet",
      rows: [],
      expected: { totalDeposited: "0", totalWithdrawn: "0", totalClaimable: "0", activeStreams: 0 },
    },
  ])("returns correct accountOverview totals for $name (#1697)", async ({ rows, expected }) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
    type AddressFilter = { sender?: string; recipient?: string };
    const matches = (row: ReturnType<typeof stream>, filter: AddressFilter) =>
      (!filter.sender || row.sender === filter.sender) &&
      (!filter.recipient || row.recipient === filter.recipient);
    prismaMock.stream.findMany.mockImplementation(async ({ where }: { where: AddressFilter & { OR?: AddressFilter[] } }) =>
      rows.filter((row) => where.OR ? where.OR.some((filter) => matches(row, filter)) : matches(row, where)),
    );
    prismaMock.stream.count.mockImplementation(async ({ where }: { where: AddressFilter }) =>
      rows.filter((row) => row.isActive && matches(row, where)).length,
    );

    const response = await request(app).post("/graphql").send({
      query: `query { accountOverview(address: "${ADDRESS}") { totalDeposited totalWithdrawn totalClaimable activeStreams } }`,
    });

    expect(response.status).toBe(200);
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.accountOverview).toEqual(expected);
  });

  it("rejects subscription operations executed over HTTP POST", async () => {
    const response = await request(app)
      .post("/graphql")
      .send({
        query: "subscription { streamUpdated(streamId: 1) { id streamId } }",
      });

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.errors)).toBe(true);
  });

  it("rejects userStreams subscription operations executed over HTTP POST", async () => {
    const response = await request(app)
      .post("/graphql")
      .send({
        query:
          'subscription { userStreams(address: "GABCDEF1234567890ABCDEF1234567890ABCDEF12345678") { id eventType timestamp } }',
      });

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.errors)).toBe(true);
  });

  it("returns proper error formatting for invalid queries", async () => {
    const response = await request(app)
      .post("/graphql")
      .send({
        query: "{ invalidField }",
      });

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.errors)).toBe(true);
  });

  describe("Issue #1698: resolveStreams status filtering without collapsing inactive states", () => {
    it.each([
      {
        status: "active",
        expectedWhere: { isActive: true, isPaused: false },
      },
      {
        status: "paused",
        expectedWhere: { isPaused: true },
      },
      {
        status: "cancelled",
        expectedWhere: { isActive: false, events: { some: { eventType: "CANCELLED" } } },
      },
      {
        status: "completed",
        expectedWhere: { isActive: false, events: { some: { eventType: "COMPLETED" } } },
      },
    ])("maps status '$status' to distinct where condition", async ({ status, expectedWhere }) => {
      let capturedWhere: any = null;
      prismaMock.stream.findMany.mockImplementation(async ({ where }: { where: any }) => {
        capturedWhere = where;
        return [];
      });

      const response = await request(app).post("/graphql").send({
        query: `query { streams(filter: { status: "${status}" }) { edges { node { id } } } }`,
      });

      expect(response.status).toBe(200);
      expect(response.body.errors).toBeUndefined();
      expect(capturedWhere).toMatchObject(expectedWhere);
    });

    it("rejects unknown status values", async () => {
      const response = await request(app).post("/graphql").send({
        query: 'query { streams(filter: { status: "unknown_status" }) { edges { node { id } } } }',
      });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.errors)).toBe(true);
      expect(response.body.errors[0].message).toContain("Invalid status filter");
    });
  });

  describe("Issue #1699: Accept full-width stream identifiers in GraphQL schema", () => {
    it("queries stream with full-width u64 ID (> 2^31 - 1)", async () => {
      const largeStreamId = "9223372036854775807"; // 2^63 - 1
      prismaMock.stream.findMany.mockResolvedValueOnce([{
        id: "stream-large",
        streamId: BigInt(largeStreamId),
        sender: ADDRESS,
        recipient: "G-RECIPIENT",
        tokenAddress: "TOKEN_A",
        ratePerSecond: "10",
        depositedAmount: "1000",
        withdrawnAmount: "0",
        startTime: BigInt(NOW),
        endTime: null,
        isActive: true,
        isPaused: false,
      }]);

      const response = await request(app).post("/graphql").send({
        query: `query { stream(streamId: "${largeStreamId}") { id streamId sender recipient } }`,
      });

      expect(response.status).toBe(200);
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.stream).not.toBeNull();
      expect(response.body.data.stream.streamId).toBe(largeStreamId);
    });

    it("rejects out-of-range stream IDs", async () => {
      const negativeStreamId = "-1";
      const response = await request(app).post("/graphql").send({
        query: `query { stream(streamId: "${negativeStreamId}") { id streamId } }`,
      });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.errors)).toBe(true);
      expect(response.body.errors[0].message).toContain("out of supported range");
    });
  });
});
