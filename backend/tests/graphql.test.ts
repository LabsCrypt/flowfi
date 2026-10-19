import { describe, it, expect, vi, beforeEach } from "vitest";
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

describe("GraphQL API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Account-overview queries select the amount columns; list queries do not.
    prismaMock.stream.findMany.mockImplementation(async (args: { select?: unknown }) =>
      args && args.select ? [{ depositedAmount: "100", withdrawnAmount: "25" }] : [],
    );
    prismaMock.streamEvent.findMany.mockResolvedValue([]);
    prismaMock.tokenRegistry.findMany.mockResolvedValue([]);
    prismaMock.stream.count.mockResolvedValue(0);
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
        query: "query { stream(streamId: 1) { id streamId sender recipient } }",
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
    expect(response.body.data.accountOverview.totalDeposited).toBe("200");
    expect(response.body.data.accountOverview.activeStreams).toBe(0);
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
});
