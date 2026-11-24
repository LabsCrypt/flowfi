/**
 * Issue #1494 — X-Request-ID must reach every response and every error body.
 *
 * Three acceptance criteria, each exercised through the real chain rather than a
 * reimplementation of it:
 *   1. every response carries the `X-Request-ID` header — including the ones
 *      answered before any route runs (a throttled 429, an unrouted 404);
 *   2. an error produced by the shared funnel in `lib/api-error.ts` carries
 *      `requestId`, with the same value the header carries, for every input the
 *      error handler accepts (`ApiError`, `ZodError`, an unknown `Error`);
 *   3. the id is handed to the logger without any handler passing it.
 *
 * A caller-supplied id is preserved verbatim when it is well formed and replaced
 * by a generated one when it is not, which is why the generated-id tests assert
 * shape rather than a fixed value.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response } from "express";
import { AsyncLocalStorage } from "async_hooks";
import { z } from "zod";
import rateLimit from "express-rate-limit";

const mocks = vi.hoisted(() => ({
  prisma: {
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
    stream: { count: vi.fn(), findMany: vi.fn() },
    streamEvent: { count: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
    indexerState: { findUnique: vi.fn() },
  },
  logLines: [] as Record<string, unknown>[],
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: mocks.prisma,
  default: mocks.prisma,
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

vi.mock("../src/lib/redis.js", () => ({
  cache: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
    del: vi.fn(),
    getMetadata: vi.fn().mockReturnValue(null),
    getStats: vi.fn().mockReturnValue({ hits: 0, misses: 0, hitRate: 0, itemCount: 0 }),
    cleanup: vi.fn(),
  },
  isRedisAvailable: vi.fn().mockReturnValue(false),
  getPublisher: vi.fn().mockReturnValue(null),
  getSubscriber: vi.fn().mockReturnValue(null),
  connectRedis: vi.fn().mockResolvedValue(undefined),
  disconnectRedis: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/sse.service.js", () => ({
  sseService: {
    broadcast: vi.fn(),
    broadcastToStream: vi.fn(),
    broadcastToAdmin: vi.fn(),
    getClientCount: vi.fn().mockReturnValue(0),
  },
  SSEService: vi.fn(() => ({})),
}));

// A Winston-shaped logger whose records carry whatever the request context
// exposed, so criterion 3 is observable without a transport. `requestContext`
// is the same object `requestIdMiddleware` imports, so the id the middleware
// stored is the id these lines report.
vi.mock("../src/logger.js", () => {
  const requestContext = new AsyncLocalStorage<{ requestId: string }>();
  const record = (level: string, message: unknown, meta?: Record<string, unknown>) => {
    mocks.logLines.push({
      level,
      message: typeof message === "string" ? message : String(message),
      requestId: requestContext.getStore()?.requestId,
      ...meta,
    });
  };
  return {
    requestContext,
    default: {
      info: (message: unknown, meta?: Record<string, unknown>) => record("info", message, meta),
      warn: (message: unknown, meta?: Record<string, unknown>) => record("warn", message, meta),
      error: (message: unknown, meta?: Record<string, unknown>) => record("error", message, meta),
      debug: (message: unknown, meta?: Record<string, unknown>) => record("debug", message, meta),
    },
  };
});

import app from "../src/app.js";
import { requestIdMiddleware } from "../src/middleware/requestId.js";
import { errorHandler } from "../src/middleware/error.middleware.js";
import { requestContext } from "../src/logger.js";
import { ApiError } from "../src/lib/api-error.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function headerId(res: request.Response): string {
  return String(res.headers["x-request-id"]);
}

function errorOf(res: request.Response): Record<string, unknown> {
  return res.body.error as Record<string, unknown>;
}

/**
 * `requestIdMiddleware` in front of the app's own error handler, with one route
 * per branch of the error funnel. This is the composition `src/app.ts` uses, so
 * an id missing from a body fails here for the same reason it would in
 * production — and none of these routes needs the database, so they are
 * deterministic in CI.
 */
function buildFunnelApp() {
  const funnel = express();
  // Same order as src/app.ts: the id exists before anything that can answer,
  // including the body parser that raises the 413 below.
  funnel.use(requestIdMiddleware);
  funnel.use(express.json({ limit: "1kb" }));

  // Mounted after requestId on purpose: a throttled response is still a response
  // the caller has to correlate, which only holds if the id exists first.
  funnel.post(
    "/throttled",
    rateLimit({ windowMs: 60_000, limit: 1, standardHeaders: false, legacyHeaders: false }),
    (_req: Request, res: Response) => {
      res.json({ ok: true });
    },
  );

  funnel.get("/ok", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  funnel.get("/id", (_req: Request, res: Response) => {
    res.json({ stored: requestContext.getStore()?.requestId });
  });

  funnel.get("/api-error", () => {
    throw new ApiError(400, "VALIDATION_ERROR", "body.token is required", { field: "token" });
  });

  funnel.get("/zod", () => {
    // A real parser failure, so the issue shape is zod's own and not a guess.
    z.object({ token: z.string() }).parse({});
  });

  funnel.get("/boom", () => {
    throw new Error("something unexpected happened");
  });

  funnel.use(errorHandler);
  return funnel;
}

describe("AC 1 — every response carries the X-Request-ID header", () => {
  beforeEach(() => {
    mocks.logLines.length = 0;
  });

  it("adds the header to a normal 200 response on the real app", async () => {
    const res = await request(app).get("/");

    expect(res.status).toBe(200);
    expect(headerId(res)).toMatch(UUID_PATTERN);
  });

  it("echoes a caller-supplied id instead of inventing one", async () => {
    const res = await request(app).get("/").set("X-Request-ID", "upstream-id-42");

    expect(headerId(res)).toBe("upstream-id-42");
  });

  it("replaces an oversized id rather than echoing it", async () => {
    const oversized = "a".repeat(200);
    const res = await request(app).get("/").set("X-Request-ID", oversized);

    expect(headerId(res)).not.toBe(oversized);
    expect(headerId(res)).toMatch(UUID_PATTERN);
  });

  it("adds the header to a 404 produced before any route runs", async () => {
    const res = await request(app).get("/v1/does-not-exist");

    expect(res.status).toBe(404);
    expect(headerId(res)).toMatch(UUID_PATTERN);
  });

  it("adds the header to a throttled 429, which the limiter answers first", async () => {
    const funnel = buildFunnelApp();

    const first = await request(funnel).post("/throttled").set("X-Request-ID", "burst-case");
    const second = await request(funnel).post("/throttled").set("X-Request-ID", "burst-case");

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(headerId(second)).toBe("burst-case");
  });

  it("gives two consecutive requests two distinct ids", async () => {
    const first = await request(buildFunnelApp()).get("/ok");
    const second = await request(buildFunnelApp()).get("/ok");

    expect(headerId(first)).not.toBe(headerId(second));
  });
});

describe("AC 2 — error responses carry requestId in the JSON body", () => {
  beforeEach(() => {
    mocks.logLines.length = 0;
  });

  it("includes requestId for an ApiError thrown from a handler", async () => {
    const res = await request(buildFunnelApp())
      .get("/api-error")
      .set("X-Request-ID", "api-error-case");

    expect(res.status).toBe(400);
    expect(errorOf(res)).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "body.token is required",
      requestId: "api-error-case",
      details: { field: "token" },
    });
    expect(errorOf(res).requestId).toBe(headerId(res));
  });

  it("includes requestId for a Zod validation error", async () => {
    const res = await request(buildFunnelApp())
      .get("/zod")
      .set("X-Request-ID", "zod-case");

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("VALIDATION_ERROR");
    expect(typeof errorOf(res).message).toBe("string");
    expect(errorOf(res).requestId).toBe("zod-case");
  });

  it("includes requestId for an unknown error and keeps code and message", async () => {
    const res = await request(buildFunnelApp())
      .get("/boom")
      .set("X-Request-ID", "unknown-case");

    expect(res.status).toBe(500);
    expect(errorOf(res).code).toBe("INTERNAL_SERVER_ERROR");
    expect(typeof errorOf(res).message).toBe("string");
    expect(errorOf(res).requestId).toBe("unknown-case");
  });

  it("stamps a generated id into the body when the caller supplied none", async () => {
    const res = await request(buildFunnelApp()).get("/api-error");

    expect(String(errorOf(res).requestId)).toMatch(UUID_PATTERN);
    expect(errorOf(res).requestId).toBe(headerId(res));
  });

  it("carries requestId on the 413 the body parser raises before routing", async () => {
    const res = await request(buildFunnelApp())
      .post("/ok")
      .set("X-Request-ID", "too-large-case")
      .send({ blob: "x".repeat(4096) });

    expect(res.status).toBe(413);
    expect(errorOf(res).code).toBe("PAYLOAD_TOO_LARGE");
    expect(errorOf(res).requestId).toBe("too-large-case");
  });

  it("does not add requestId to a successful body — it is an error-envelope field", async () => {
    const res = await request(buildFunnelApp()).get("/ok").set("X-Request-ID", "success-case");

    expect(res.status).toBe(200);
    expect(res.body?.requestId).toBeUndefined();
  });
});

describe("AC 3 — the id is available to logging without being passed", () => {
  beforeEach(() => {
    mocks.logLines.length = 0;
  });

  it("publishes the id into the request context for the handler", async () => {
    const res = await request(buildFunnelApp()).get("/id").set("X-Request-ID", "context-case");

    expect(res.status).toBe(200);
    expect(res.body.stored).toBe("context-case");
    expect(headerId(res)).toBe("context-case");
  });

  it("generates a context id when the caller supplied none", async () => {
    const res = await request(buildFunnelApp()).get("/id");

    expect(String(res.body.stored)).toMatch(UUID_PATTERN);
    expect(headerId(res)).toBe(res.body.stored);
  });

  it("stamps requestId on log lines emitted while handling a request", async () => {
    await request(buildFunnelApp()).get("/boom").set("X-Request-ID", "logged-case");

    expect(mocks.logLines.length).toBeGreaterThan(0);
    // Every line written while the request was in flight is correlated — not just
    // the ones the error handler was told about.
    expect(mocks.logLines.every((line) => line.requestId === "logged-case")).toBe(true);
  });
});

describe("middleware order in the real app", () => {
  it("answers a body-parser error from the real app with a correlated id", async () => {
    // A 1MB body against the app's 100kb global JSON limit: the id is already on
    // the response before the limiter or any router runs, which is what the
    // reordering in src/app.ts buys, and this is the app's own chain — not a
    // test composition.
    const res = await request(app)
      .post("/v1/definitely-not-a-route")
      .set("X-Request-ID", "real-app-order")
      .send({ blob: "x".repeat(150_000) });

    expect(res.status).toBe(413);
    expect(errorOf(res).requestId).toBe("real-app-order");
    expect(headerId(res)).toBe("real-app-order");
  });
});
