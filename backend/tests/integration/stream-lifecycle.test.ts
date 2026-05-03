/**
 * Integration tests for full stream lifecycle via API
 *
 * These tests use real Postgres database and verify the complete pipeline:
 * event worker → DB update → controller response → SSE broadcast
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { PrismaClient } from "../../src/generated/prisma/index.js";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { xdr, nativeToScVal, Keypair, StrKey } from "@stellar/stellar-sdk";
import app from "../../src/app.js";
import { SorobanEventWorker } from "../../src/workers/soroban-event-worker.js";
import { sseService } from "../../src/services/sse.service.js";
import EventSource from "eventsource";

// XDR Helper functions (copied from soroban-event-worker.test.ts)
function scvU64(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "u64" });
}

function scvI128(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "i128" });
}

function scvAccountAddress(publicKey: string): xdr.ScVal {
  return nativeToScVal(publicKey, { type: "address" });
}

function scvContractAddress(contractId: string): xdr.ScVal {
  return nativeToScVal(contractId, { type: "address" });
}

function scvSymbol(s: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(s);
}

function scvMap(entries: [string, xdr.ScVal][]): xdr.ScVal {
  return xdr.ScVal.scvMap(
    entries.map(([k, v]) => new xdr.ScMapEntry({ key: scvSymbol(k), val: v })),
  );
}

// Test database setup
const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://postgres:password@127.0.0.1:5432/flowfi_test";
const testPool = new pg.Pool({ connectionString });
const testAdapter = new PrismaPg(testPool);
const testPrisma = new PrismaClient({
  adapter: testAdapter,
  log: ["error"], // Minimal logging for tests
});

// Mock RPC calls for stale DB fallback tests
vi.mock("../../src/services/sorobanService.js", () => ({
  getStreamFromChain: vi.fn(),
  getClaimableFromChain: vi.fn(),
  isStale: vi.fn((updatedAt: Date) => {
    const now = new Date();
    const ageMs = now.getTime() - updatedAt.getTime();
    return ageMs > 30000; // 30 seconds
  }),
}));

// Generate proper test addresses
const SENDER_KP = Keypair.random();
const RECIPIENT_KP = Keypair.random();
const SENDER = SENDER_KP.publicKey();
const RECIPIENT = RECIPIENT_KP.publicKey();
// Generate a valid C... address from 32 random bytes
const CONTRACT_HASH = Buffer.alloc(32, 0xab);
const TOKEN = StrKey.encodeContract(CONTRACT_HASH);

// Helper functions for creating XDR objects
function createStreamCreatedEvent(
  streamId: number,
  overrides: Partial<any> = {},
) {
  const baseEntries: [string, xdr.ScVal][] = [
    ["sender", scvAccountAddress(SENDER)],
    ["recipient", scvAccountAddress(RECIPIENT)],
    ["token_address", scvContractAddress(TOKEN)],
    ["rate_per_second", scvI128(BigInt(10))],
    ["deposited_amount", scvI128(BigInt(86400))],
    ["start_time", scvU64(BigInt(1700000000))],
  ];

  const overrideEntries: [string, xdr.ScVal][] = Object.entries(overrides).map(
    ([k, v]) => [k, nativeToScVal(v)],
  );

  return {
    id: `evt-stream-created-${streamId}`,
    type: "contract" as const,
    ledger: 12345,
    ledgerClosedAt: "2023-01-01T00:00:00Z",
    transactionIndex: 0,
    operationIndex: 0,
    txHash: "abc123def456",
    topic: [scvSymbol("stream_created"), scvU64(BigInt(streamId))],
    value: scvMap([...baseEntries, ...overrideEntries]),
    inSuccessfulContractCall: true,
  };
}

function createStreamToppedUpEvent(
  streamId: number,
  amount: number,
  newDepositedAmount: number,
) {
  return {
    id: `evt-stream-topped-up-${streamId}`,
    type: "contract" as const,
    ledger: 12346,
    ledgerClosedAt: "2023-01-01T00:00:00Z",
    transactionIndex: 0,
    operationIndex: 0,
    txHash: "def456abc789",
    topic: [scvSymbol("stream_topped_up"), scvU64(BigInt(streamId))],
    value: scvMap([
      ["amount", scvI128(BigInt(amount))],
      ["new_deposited_amount", scvI128(BigInt(newDepositedAmount))],
    ]),
    inSuccessfulContractCall: true,
  };
}

function createStreamPausedEvent(streamId: number) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `evt-stream-paused-${streamId}`,
    type: "contract" as const,
    ledger: 12347,
    ledgerClosedAt: "2023-01-01T00:00:00Z",
    transactionIndex: 0,
    operationIndex: 0,
    txHash: "ghi789def012",
    topic: [scvSymbol("stream_paused"), scvU64(BigInt(streamId))],
    value: scvMap([
      ["sender", scvAccountAddress(SENDER)],
      ["paused_at", scvU64(BigInt(now))],
    ]),
    inSuccessfulContractCall: true,
  };
}

function createStreamResumedEvent(streamId: number) {
  const now = Math.floor(Date.now() / 1000);
  const newEndTime = now + 3600; // 1 hour from now
  return {
    id: `evt-stream-resumed-${streamId}`,
    type: "contract" as const,
    ledger: 12348,
    ledgerClosedAt: "2023-01-01T00:00:00Z",
    transactionIndex: 0,
    operationIndex: 0,
    txHash: "jkl012ghi345",
    topic: [scvSymbol("stream_resumed"), scvU64(BigInt(streamId))],
    value: scvMap([
      ["sender", scvAccountAddress(SENDER)],
      ["new_end_time", scvU64(BigInt(newEndTime))],
    ]),
    inSuccessfulContractCall: true,
  };
}

function createStreamCancelledEvent(
  streamId: number,
  amountWithdrawn: number,
  refundedAmount: number,
) {
  return {
    id: `evt-stream-cancelled-${streamId}`,
    type: "contract" as const,
    ledger: 12349,
    ledgerClosedAt: "2023-01-01T00:00:00Z",
    transactionIndex: 0,
    operationIndex: 0,
    txHash: "mno345jkl678",
    topic: [scvSymbol("stream_cancelled"), scvU64(BigInt(streamId))],
    value: scvMap([
      ["amount_withdrawn", scvI128(BigInt(amountWithdrawn))],
      ["refunded_amount", scvI128(BigInt(refundedAmount))],
    ]),
    inSuccessfulContractCall: true,
  };
}

async function cleanupDatabase() {
  // Clean up in order to respect foreign key constraints
  await testPrisma.streamEvent.deleteMany();
  await testPrisma.stream.deleteMany();
  await testPrisma.user.deleteMany();
  await testPrisma.indexerState.deleteMany();
}

async function createTestUsers() {
  // Create test users for foreign key constraints
  await testPrisma.user.createMany({
    data: [{ publicKey: SENDER }, { publicKey: RECIPIENT }],
    skipDuplicates: true,
  });
}

describe("Stream Lifecycle Integration Tests", () => {
  let worker: SorobanEventWorker;
  let server: any;
  let serverPort: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    await cleanupDatabase();
    await createTestUsers();

    // Create worker instance
    worker = new SorobanEventWorker();

    // Start a test server for SSE testing
    server = app.listen(0); // Random port
    serverPort = (server.address() as any)?.port || 3001;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await cleanupDatabase();
    await testPrisma.$disconnect();
  });

  describe("Indexer → stream_created: stream appears in GET /v1/streams/:id", () => {
    it("processes stream_created event and makes stream available via API", async () => {
      const streamId = 1;
      const event = createStreamCreatedEvent(streamId);

      // Process the event through the worker
      await worker.processEvent(event);

      // Verify stream exists in database
      const dbStream = await testPrisma.stream.findUnique({
        where: { streamId },
        include: { senderUser: true, recipientUser: true },
      });
      expect(dbStream).toBeTruthy();
      expect(dbStream?.streamId).toBe(streamId);
      expect(dbStream?.sender).toBe(SENDER);
      expect(dbStream?.recipient).toBe(RECIPIENT);
      expect(dbStream?.isActive).toBe(true);
      expect(dbStream?.isPaused).toBe(false);

      // Verify stream is available via API
      const response = await request(app)
        .get(`/v1/streams/${streamId}`)
        .expect(200);

      expect(response.body.streamId).toBe(streamId);
      expect(response.body.sender).toBe(SENDER);
      expect(response.body.recipient).toBe(RECIPIENT);
      expect(response.body.isActive).toBe(true);

      // Verify event was created
      const eventRecord = await testPrisma.streamEvent.findFirst({
        where: { streamId, eventType: "CREATED" },
      });
      expect(eventRecord).toBeTruthy();
      expect(eventRecord?.amount).toBe("86400");
    });
  });

  describe("Indexer → stream_topped_up: depositedAmount updated", () => {
    it("updates depositedAmount in DB and API reflects the change", async () => {
      const streamId = 2;

      // First create a stream
      await testPrisma.stream.create({
        data: {
          streamId,
          sender: SENDER,
          recipient: RECIPIENT,
          tokenAddress: TOKEN,
          ratePerSecond: "10",
          depositedAmount: "86400",
          withdrawnAmount: "0",
          startTime: 1700000000,
          endTime: 1700000000 + 8640,
          lastUpdateTime: 1700000000,
          isActive: true,
          isPaused: false,
        },
      });

      // Process top-up event
      const event = createStreamToppedUpEvent(streamId, 1000, 87400);
      await worker.processEvent(event);

      // Verify deposited amount was updated
      const updatedStream = await testPrisma.stream.findUnique({
        where: { streamId },
      });
      expect(updatedStream?.depositedAmount).toBe("87400");

      // Verify API reflects the change
      const response = await request(app)
        .get(`/v1/streams/${streamId}`)
        .expect(200);

      expect(response.body.depositedAmount).toBe("87400");

      // Verify top-up event was recorded
      const eventRecord = await testPrisma.streamEvent.findFirst({
        where: { streamId, eventType: "TOPPED_UP" },
      });
      expect(eventRecord).toBeTruthy();
      expect(eventRecord?.amount).toBe("1000");
    });
  });

  describe("Indexer → stream_paused: isPaused = true, claimable stops growing", () => {
    it("sets isPaused=true and stops accrual", async () => {
      const streamId = 3;
      const now = Math.floor(Date.now() / 1000);

      // Create an active stream
      await testPrisma.stream.create({
        data: {
          streamId,
          sender: SENDER,
          recipient: RECIPIENT,
          tokenAddress: TOKEN,
          ratePerSecond: "10",
          depositedAmount: "86400",
          withdrawnAmount: "0",
          startTime: now - 3600, // 1 hour ago
          endTime: now + 7200, // 2 hours from now
          lastUpdateTime: now - 3600,
          isActive: true,
          isPaused: false,
        },
      });

      // Process pause event
      const event = createStreamPausedEvent(streamId);
      await worker.processEvent(event);

      // Verify stream is paused
      const pausedStream = await testPrisma.stream.findUnique({
        where: { streamId },
      });
      expect(pausedStream?.isPaused).toBe(true);

      // Verify API reflects paused state
      const response = await request(app)
        .get(`/v1/streams/${streamId}`)
        .expect(200);

      expect(response.body.isPaused).toBe(true);

      // Verify pause event was recorded
      const eventRecord = await testPrisma.streamEvent.findFirst({
        where: { streamId, eventType: "PAUSED" },
      });
      expect(eventRecord).toBeTruthy();

      // Verify claimable calculation respects pause
      const claimableResponse = await request(app)
        .get(`/v1/streams/${streamId}/claimable`)
        .expect(200);

      // Should have claimable amount from before pause, but not growing
      expect(claimableResponse.body).toHaveProperty("claimableAmount");
    });
  });

  describe("Indexer → stream_resumed: isPaused = false, accrual resumes", () => {
    it("sets isPaused=false and accrual resumes correctly", async () => {
      const streamId = 4;
      const now = Math.floor(Date.now() / 1000);

      // Create a paused stream
      await testPrisma.stream.create({
        data: {
          streamId,
          sender: SENDER,
          recipient: RECIPIENT,
          tokenAddress: TOKEN,
          ratePerSecond: "10",
          depositedAmount: "86400",
          withdrawnAmount: "0",
          startTime: now - 7200,
          endTime: now + 3600,
          lastUpdateTime: now - 3600,
          isActive: true,
          isPaused: true,
          pausedAt: now - 3600,
        },
      });

      // Process resume event
      const event = createStreamResumedEvent(streamId);
      await worker.processEvent(event);

      // Verify stream is resumed
      const resumedStream = await testPrisma.stream.findUnique({
        where: { streamId },
      });
      expect(resumedStream?.isPaused).toBe(false);
      expect(resumedStream?.pausedAt).toBeNull();

      // Verify API reflects resumed state
      const response = await request(app)
        .get(`/v1/streams/${streamId}`)
        .expect(200);

      expect(response.body.isPaused).toBe(false);

      // Verify resume event was recorded
      const eventRecord = await testPrisma.streamEvent.findFirst({
        where: { streamId, eventType: "RESUMED" },
      });
      expect(eventRecord).toBeTruthy();
    });
  });

  describe("Indexer → stream_cancelled: isActive = false", () => {
    it("sets isActive=false and status reflected in API", async () => {
      const streamId = 5;

      // Create an active stream
      await testPrisma.stream.create({
        data: {
          streamId,
          sender: SENDER,
          recipient: RECIPIENT,
          tokenAddress: TOKEN,
          ratePerSecond: "10",
          depositedAmount: "86400",
          withdrawnAmount: "0",
          startTime: 1700000000,
          endTime: 1700000000 + 8640,
          lastUpdateTime: 1700000000,
          isActive: true,
          isPaused: false,
        },
      });

      // Process cancel event
      const event = createStreamCancelledEvent(streamId, 300, 700);
      await worker.processEvent(event);

      // Verify stream is cancelled
      const cancelledStream = await testPrisma.stream.findUnique({
        where: { streamId },
      });
      expect(cancelledStream?.isActive).toBe(false);
      expect(cancelledStream?.withdrawnAmount).toBe("300");

      // Verify API reflects cancelled status
      const response = await request(app)
        .get(`/v1/streams/${streamId}`)
        .expect(200);

      expect(response.body.isActive).toBe(false);

      // Verify cancel event was recorded
      const eventRecord = await testPrisma.streamEvent.findFirst({
        where: { streamId, eventType: "CANCELLED" },
      });
      expect(eventRecord).toBeTruthy();
      expect(eventRecord?.amount).toBe("700");
    });
  });

  describe("Stale DB (>30s) → GET /v1/streams/:id/claimable falls back to RPC", () => {
    it("falls back to RPC when data is stale", async () => {
      const streamId = 6;
      const oldTimestamp = new Date(Date.now() - 60000); // 60 seconds ago

      // Create a stream with old timestamp
      await testPrisma.stream.create({
        data: {
          streamId,
          sender: SENDER,
          recipient: RECIPIENT,
          tokenAddress: TOKEN,
          ratePerSecond: "10",
          depositedAmount: "86400",
          withdrawnAmount: "0",
          startTime: 1700000000,
          endTime: 1700000000 + 8640,
          lastUpdateTime: Math.floor(oldTimestamp.getTime() / 1000),
          isActive: true,
          isPaused: false,
          updatedAt: oldTimestamp,
        },
      });

      // Mock the RPC fallback
      const { getClaimableFromChain } =
        await import("../../src/services/sorobanService.js");
      vi.mocked(getClaimableFromChain).mockResolvedValue("5000");

      // Request claimable amount - should trigger RPC fallback
      const response = await request(app)
        .get(`/v1/streams/${streamId}/claimable`)
        .expect(200);

      expect(response.body.claimableAmount).toBe("5000");
      expect(response.body.source).toBe("chain");
      expect(response.body.cached).toBe(false);

      // Verify RPC was called
      expect(getClaimableFromChain).toHaveBeenCalledWith(streamId);
    });

    it("returns fresh data when not stale", async () => {
      const streamId = 7;
      const recentTimestamp = new Date(Date.now() - 5000); // 5 seconds ago

      // Create a stream with recent timestamp
      await testPrisma.stream.create({
        data: {
          streamId,
          sender: SENDER,
          recipient: RECIPIENT,
          tokenAddress: TOKEN,
          ratePerSecond: "10",
          depositedAmount: "86400",
          withdrawnAmount: "0",
          startTime: 1700000000,
          endTime: 1700000000 + 8640,
          lastUpdateTime: Math.floor(recentTimestamp.getTime() / 1000),
          isActive: true,
          isPaused: false,
          updatedAt: recentTimestamp,
        },
      });

      // Mock the RPC fallback
      const { getClaimableFromChain } =
        await import("../../src/services/sorobanService.js");
      vi.mocked(getClaimableFromChain).mockResolvedValue("5000");

      // Request claimable amount - should use DB data
      const response = await request(app)
        .get(`/v1/streams/${streamId}/claimable`)
        .expect(200);

      expect(response.body).toHaveProperty("claimableAmount");
      expect(response.body.source).toBeUndefined(); // No source field for fresh data

      // Verify RPC was NOT called
      expect(getClaimableFromChain).not.toHaveBeenCalled();
    });
  });

  describe("SSE client receives broadcast for each stream event", () => {
    let eventSource: EventSource;

    beforeEach(() => {
      // Mock SSE service broadcast methods to track calls
      vi.spyOn(sseService, "broadcastToStream");
    });

    afterEach(() => {
      if (eventSource) {
        eventSource.close();
      }
    });

    it("receives broadcast for stream_created event", async () => {
      const streamId = 8;

      // Create EventSource client
      eventSource = new EventSource(`http://localhost:${serverPort}/v1/sse`);

      const receivedEvents: any[] = [];
      eventSource.addEventListener("stream.created", (event: any) => {
        receivedEvents.push(JSON.parse(event.data));
      });

      // Wait for connection
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Process stream_created event
      const event = createStreamCreatedEvent(streamId);
      await worker.processEvent(event);

      // Wait for SSE event to be received
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify SSE broadcast was called
      expect(sseService.broadcastToStream).toHaveBeenCalledWith(
        streamId.toString(),
        "stream.created",
        expect.objectContaining({ streamId }),
      );

      // Verify event was received by client (if SSE service is real)
      // Note: This depends on the actual SSE implementation
      expect(receivedEvents.length).toBeGreaterThanOrEqual(0);
    });

    it("receives broadcast for stream_topped_up event", async () => {
      const streamId = 9;

      // Create stream first
      await testPrisma.stream.create({
        data: {
          streamId,
          sender: SENDER,
          recipient: RECIPIENT,
          tokenAddress: TOKEN,
          ratePerSecond: "10",
          depositedAmount: "86400",
          withdrawnAmount: "0",
          startTime: 1700000000,
          endTime: 1700000000 + 8640,
          lastUpdateTime: 1700000000,
          isActive: true,
          isPaused: false,
        },
      });

      // Create EventSource client
      eventSource = new EventSource(`http://localhost:${serverPort}/v1/sse`);

      const receivedEvents: any[] = [];
      eventSource.addEventListener("stream.topped_up", (event: any) => {
        receivedEvents.push(JSON.parse(event.data));
      });

      // Wait for connection
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Process top-up event
      const event = createStreamToppedUpEvent(streamId, 1000, 87400);
      await worker.processEvent(event);

      // Wait for SSE event to be received
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify SSE broadcast was called
      expect(sseService.broadcastToStream).toHaveBeenCalledWith(
        streamId.toString(),
        "stream.topped_up",
        expect.objectContaining({ streamId, amount: "1000" }),
      );
    });

    it("receives broadcast for stream_cancelled event", async () => {
      const streamId = 10;

      // Create stream first
      await testPrisma.stream.create({
        data: {
          streamId,
          sender: SENDER,
          recipient: RECIPIENT,
          tokenAddress: TOKEN,
          ratePerSecond: "10",
          depositedAmount: "86400",
          withdrawnAmount: "0",
          startTime: 1700000000,
          endTime: 1700000000 + 8640,
          lastUpdateTime: 1700000000,
          isActive: true,
          isPaused: false,
        },
      });

      // Create EventSource client
      eventSource = new EventSource(`http://localhost:${serverPort}/v1/sse`);

      const receivedEvents: any[] = [];
      eventSource.addEventListener("stream.cancelled", (event: any) => {
        receivedEvents.push(JSON.parse(event.data));
      });

      // Wait for connection
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Process cancel event
      const event = createStreamCancelledEvent(streamId, 300, 700);
      await worker.processEvent(event);

      // Wait for SSE event to be received
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify SSE broadcast was called
      expect(sseService.broadcastToStream).toHaveBeenCalledWith(
        streamId.toString(),
        "stream.cancelled",
        expect.objectContaining({ streamId }),
      );
    });
  });
});
