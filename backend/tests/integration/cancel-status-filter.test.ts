/**
 * Integration test for issue #1219.
 *
 * Cancelling a stream through the API must write a provisional CANCELLED
 * StreamEvent together with the isActive=false update, so the stream
 * immediately matches the "cancelled" status filter. The indexer later
 * reconciles the provisional record with the authoritative on-chain event.
 *
 * Uses a real Postgres database (skipped cleanly when DATABASE_URL is not
 * reachable, mirroring stream-lifecycle.test.ts).
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import request from "supertest";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { xdr, nativeToScVal } from "@stellar/stellar-sdk";
import type { PrismaClient } from "../../src/generated/prisma/index.js";
import app from "../../src/app.js";
import { SorobanEventWorker } from "../../src/workers/soroban-event-worker.js";
import {
  resolveDbReadiness,
  resolveTestDatabaseUrl,
  explainSkipReason,
} from "./_db.js";

const { SENDER, RECIPIENT, TOKEN, API_CANCEL_TX } = vi.hoisted(() => ({
  SENDER: "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7",
  RECIPIENT: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  TOKEN: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  API_CANCEL_TX: "api_cancel_tx_hash",
}));

vi.mock("../../src/services/sorobanService.js", () => ({
  cancelStream: vi.fn().mockResolvedValue(API_CANCEL_TX),
  getStreamFromChain: vi.fn(),
  getClaimableFromChain: vi.fn(),
  isStale: vi.fn().mockReturnValue(false),
}));

// Bypass real Stellar signature verification; identify the caller via header.
vi.mock("../../src/middleware/auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/middleware/auth.js")>();
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      req.user = { publicKey: req.headers["x-test-caller"] ?? SENDER };
      next();
    },
    requireAdmin: (_req: any, res: any, _next: any) => {
      res.status(403).json({ error: "Forbidden" });
    },
  };
});

let testPrisma!: PrismaClient;
let testPool!: pg.Pool;
let lastDbReadiness: Awaited<ReturnType<typeof resolveDbReadiness>> | null =
  null;

function getDb(): PrismaClient {
  if (!testPrisma) {
    throw new Error("testPrisma accessed before initialization");
  }
  return testPrisma;
}

function scvU64(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "u64" });
}
function scvI128(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "i128" });
}
function scvSymbol(s: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(s);
}
function scvMap(entries: [string, xdr.ScVal][]): xdr.ScVal {
  return xdr.ScVal.scvMap(
    entries.map(([k, v]) => new xdr.ScMapEntry({ key: scvSymbol(k), val: v })),
  );
}

function createStreamCancelledEvent(
  streamId: number,
  amountWithdrawn: number,
  refundedAmount: number,
  txHash: string,
  ledger = 9001,
) {
  return {
    id: `evt-stream-cancelled-${streamId}`,
    type: "contract" as const,
    ledger,
    ledgerClosedAt: "2023-01-01T00:00:00Z",
    transactionIndex: 0,
    operationIndex: 0,
    txHash,
    topic: [scvSymbol("stream_cancelled"), scvU64(BigInt(streamId))],
    value: scvMap([
      ["amount_withdrawn", scvI128(BigInt(amountWithdrawn))],
      ["refunded_amount", scvI128(BigInt(refundedAmount))],
    ]),
    inSuccessfulContractCall: true,
  };
}

async function cleanupDatabase() {
  const db = getDb();
  await db.streamEvent.deleteMany();
  await db.stream.deleteMany();
  await db.user.deleteMany();
}

const STREAM_ID = 900;

async function seedActiveStream() {
  const db = getDb();
  await db.user.createMany({
    data: [{ publicKey: SENDER }, { publicKey: RECIPIENT }],
    skipDuplicates: true,
  });
  await db.stream.create({
    data: {
      streamId: BigInt(STREAM_ID),
      sender: SENDER,
      recipient: RECIPIENT,
      tokenAddress: TOKEN,
      ratePerSecond: "10",
      depositedAmount: "86400",
      withdrawnAmount: "0",
      startTime: 1700000000,
      endTime: 1700086400,
      lastUpdateTime: 1700000000,
      isActive: true,
      isPaused: false,
    },
  });
}

async function cancelViaApi() {
  return request(app)
    .post(`/v1/streams/${STREAM_ID}/cancel`)
    .set("Authorization", "Bearer dummy_token")
    .set("x-test-caller", SENDER)
    .send({ senderSecret: "S_SECRET_123" });
}

describe("API cancel → cancelled status filter (issue #1219)", () => {
  beforeAll(async () => {
    const readiness = await resolveDbReadiness();
    lastDbReadiness = readiness;
    if (!readiness.ready) {
      // eslint-disable-next-line no-console
      console.warn(`\n${explainSkipReason(readiness)}\n`);
      return;
    }

    const { PrismaClient: PrismaClientCtor } = await import(
      "../../src/generated/prisma/index.js"
    );
    const { createPgPool } = await import("../../src/lib/pg-pool.js");
    testPool = createPgPool({ connectionString: resolveTestDatabaseUrl() });
    const adapter = new PrismaPg(testPool);
    testPrisma = new PrismaClientCtor({ adapter, log: ["error"] });
  });

  beforeEach(async (ctx) => {
    if (!lastDbReadiness?.ready) {
      ctx.skip();
      return;
    }
    vi.clearAllMocks();
    await cleanupDatabase();
    await seedActiveStream();
  });

  afterEach(async () => {
    if (!lastDbReadiness?.ready) return;
    await cleanupDatabase();
  });

  afterAll(async () => {
    if (!lastDbReadiness?.ready || !testPrisma) return;
    await testPrisma.$disconnect();
    await testPool.end().catch(() => undefined);
  });

  it("writes a provisional CANCELLED event so the stream appears under status=cancelled", async () => {
    const res = await cancelViaApi();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ txHash: API_CANCEL_TX, status: "CANCELLED" });

    // The stream is now inactive...
    const stream = await getDb().stream.findUnique({
      where: { streamId: BigInt(STREAM_ID) },
    });
    expect(stream?.isActive).toBe(false);

    // ...and immediately matches the "cancelled" status filter.
    const cancelledRes = await request(app)
      .get(`/v1/streams?status=cancelled&sender=${SENDER}`)
      .expect(200);
    const cancelledIds = cancelledRes.body.data.map((s: any) =>
      String(s.streamId),
    );
    expect(cancelledIds).toContain(String(STREAM_ID));

    // It no longer matches the "active" filter.
    const activeRes = await request(app)
      .get(`/v1/streams?status=active&sender=${SENDER}`)
      .expect(200);
    const activeIds = activeRes.body.data.map((s: any) => String(s.streamId));
    expect(activeIds).not.toContain(String(STREAM_ID));

    // A provisional CANCELLED event was persisted with the cancel tx hash.
    const event = await getDb().streamEvent.findFirst({
      where: { streamId: BigInt(STREAM_ID), eventType: "CANCELLED" },
    });
    expect(event).not.toBeNull();
    expect(event?.transactionHash).toBe(API_CANCEL_TX);
    expect(JSON.parse(event?.metadata ?? "{}")).toMatchObject({
      provisional: true,
    });
  });

  it("reconciles the provisional event once the indexer sees the same transaction", async () => {
    await cancelViaApi();

    const worker = new SorobanEventWorker();
    await worker.processEvent(
      createStreamCancelledEvent(STREAM_ID, 300, 700, API_CANCEL_TX, 9001),
    );

    // No duplicate: the provisional row is updated in place.
    const events = await getDb().streamEvent.findMany({
      where: { streamId: BigInt(STREAM_ID), eventType: "CANCELLED" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.ledgerSequence).toBe(9001);
    expect(events[0]?.amount).toBe("700");

    // The authoritative on-chain amounts are applied to the stream.
    const stream = await getDb().stream.findUnique({
      where: { streamId: BigInt(STREAM_ID) },
    });
    expect(stream?.withdrawnAmount).toBe("300");
    expect(stream?.isActive).toBe(false);

    // Still exactly one entry under the cancelled filter.
    const cancelledRes = await request(app)
      .get(`/v1/streams?status=cancelled&sender=${SENDER}`)
      .expect(200);
    expect(cancelledRes.body.data).toHaveLength(1);
  });
});
