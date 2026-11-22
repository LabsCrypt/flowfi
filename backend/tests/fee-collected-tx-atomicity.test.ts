/**
 * Issue #1239 — fee-collection events must not race themselves.
 *
 * `handleFeeCollected` reads the dedup row and then writes it. As two separate
 * top-level `prisma` calls those two statements autocommit independently, so two
 * deliveries of the same transaction (RPC retry, ledger replay, an
 * operator-triggered re-poll) can both see "no fee event yet" and both insert.
 * The unique index on `(transactionHash, eventType)` then rejects the second
 * insert with P2002, which surfaces as a 500 on the fee path and quarantines an
 * event whose row was already correct.
 *
 * The fix wraps check + write in one `prisma.$transaction` — the shape every
 * sibling handler in `soroban-event-worker.ts` already uses.
 *
 * The fake below models that difference rather than just counting calls:
 *   - the top-level client commits each statement immediately and takes no lock,
 *     so a check/write pair issued against it interleaves with another pair;
 *   - `$transaction` serializes transactions against each other (Postgres
 *     reaches the same outcome by blocking the second conflicting insert on the
 *     unique index) and commits its writes only at the end.
 *
 * Reverting to two top-level calls therefore produces two rows here, not merely
 * a different mock call count.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { rpc } from "@stellar/stellar-sdk";

// ─── Fake Postgres ───────────────────────────────────────────────────────────

interface DedupWhere {
  transactionHash_eventType: { transactionHash: string; eventType: string };
}

interface UpsertArgs {
  where: DedupWhere;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

/**
 * Read-your-writes lookup over the rows committed so far. `pending` is the
 * transaction-local buffer; the top-level client passes no buffer at all, which
 * is what makes a non-transactional check/write pair observable.
 */
function findRow(rows: unknown[], where: DedupWhere) {
  const key = where.transactionHash_eventType;
  return (
    rows.find(
      (candidate) =>
        (candidate as Record<string, unknown>).transactionHash ===
          key.transactionHash &&
        (candidate as Record<string, unknown>).eventType === key.eventType,
    ) ?? null
  );
}

const db = vi.hoisted(() => ({
  committed: [] as unknown[],
  createStatements: 0,
  transactionCommits: 0,
}));

const mockPrismaObj = vi.hoisted(() => ({
  streamEvent: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: mockPrismaObj,
  default: mockPrismaObj,
}));

vi.mock("../src/services/sse.service.js", () => ({
  sseService: {
    broadcast: vi.fn(),
    broadcastToStream: vi.fn(),
    broadcastToAdmin: vi.fn(),
  },
}));

vi.mock("../src/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  requestContext: {
    getStore: () => undefined,
    run: (_store: unknown, cb: () => unknown) => cb(),
  },
}));

import { SorobanEventWorker } from "../src/workers/soroban-event-worker.js";
import { sseService } from "../src/services/sse.service.js";

// ─── ScVal mock helpers (same shapes as tests/soroban-event-worker.test.ts) ──

const mockSym = (name: string) => ({ sym: { toString: () => name } } as any);
const mockU64 = (value: number | bigint | string) =>
  ({ u64: { toString: () => String(value) } } as any);
const mockI128 = (hi: number | bigint | string, lo: number | bigint | string) =>
  ({
    i128: {
      hi: { toString: () => String(hi) },
      lo: { toString: () => String(lo) },
    },
  } as any);
const mockContractAddr = (fill: number) =>
  ({
    address: {
      type: "scAddressTypeContract",
      contractId: { value: Buffer.alloc(32, fill) },
    },
  } as any);
const mockMapEntry = (keyName: string, val: unknown) =>
  ({ key: mockSym(keyName), val } as any);

const TX_HASH = "fee-race-tx-hash";

function feeCollectedEvent(feeUnits: string): rpc.Api.EventResponse {
  return {
    id: `fee-event-${feeUnits}`,
    type: "contract",
    ledger: 4_200_000,
    ledgerClosedAt: "2026-11-21T00:00:00Z",
    txHash: TX_HASH,
    transactionIndex: 3,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [mockSym("fee_collected"), mockU64(777n)],
    value: {
      type: "scvMap",
      map: [
        mockMapEntry("treasury", mockContractAddr(0xaa)),
        mockMapEntry("fee_amount", mockI128(0, feeUnits)),
        mockMapEntry("token", mockContractAddr(0xbb)),
      ],
    },
  } as unknown as rpc.Api.EventResponse;
}

describe("FeeCollected dedup + write atomicity (#1239)", () => {
  let worker: SorobanEventWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    db.committed.length = 0;
    db.createStatements = 0;
    db.transactionCommits = 0;
    worker = new SorobanEventWorker();

    // Top-level statements: autocommit, no serialization between the read and
    // the write. Only a handler that ignores $transaction goes through here.
    mockPrismaObj.streamEvent.findUnique.mockImplementation(async ({ where }: any) =>
      findRow(db.committed, where),
    );
    mockPrismaObj.streamEvent.upsert.mockImplementation(async (args: UpsertArgs) => {
      const existing = findRow(db.committed, args.where);
      if (existing) return existing; // `update: {}` — nothing to change
      db.createStatements += 1;
      db.committed.push({ ...args.create });
      return args.create;
    });

    // Transactions: serialized against each other, writes held until commit.
    let tail: Promise<unknown> = Promise.resolve();
    mockPrismaObj.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const run = async () => {
          const pending: unknown[] = [];
          const tx = {
            streamEvent: {
              findUnique: async ({ where }: any) =>
                findRow(db.committed, where) ?? findRow(pending, where),
              upsert: async (args: UpsertArgs) => {
                const existing =
                  findRow(db.committed, args.where) ?? findRow(pending, args.where);
                if (existing) return existing;
                db.createStatements += 1;
                pending.push({ ...args.create });
                return args.create;
              },
            },
          };
          const result = await fn(tx);
          db.committed.push(...pending);
          db.transactionCommits += 1;
          return result;
        };
        const scheduled = tail.then(run, run);
        tail = scheduled.catch(() => undefined);
        return scheduled;
      },
    );
  });

  it("creates exactly one StreamEvent row when the same txHash is delivered twice at once", async () => {
    const event = feeCollectedEvent("1500");

    await Promise.all([
      (worker as any).handleFeeCollected(event, event.topic[1]),
      (worker as any).handleFeeCollected(event, event.topic[1]),
    ]);

    expect(db.committed).toHaveLength(1);
    expect(db.createStatements).toBe(1);
    expect((db.committed[0] as Record<string, unknown>).amount).toBe("1500");
  });

  it("keeps the dedup read and the write in one transaction, never on the top-level client", async () => {
    const event = feeCollectedEvent("1500");

    await (worker as any).handleFeeCollected(event, event.topic[1]);

    expect(mockPrismaObj.$transaction).toHaveBeenCalledTimes(1);
    // The audit's complaint is precisely that these two were top-level calls.
    expect(mockPrismaObj.streamEvent.findUnique).not.toHaveBeenCalled();
    expect(mockPrismaObj.streamEvent.upsert).not.toHaveBeenCalled();
    expect(db.transactionCommits).toBe(1);
  });

  it("records one row when the duplicate arrives after the first has committed", async () => {
    const event = feeCollectedEvent("1500");

    await (worker as any).handleFeeCollected(event, event.topic[1]);
    await (worker as any).handleFeeCollected(event, event.topic[1]);

    expect(db.committed).toHaveLength(1);
    expect(db.createStatements).toBe(1);
  });

  it("broadcasts the fee once per delivery and stores treasury plus token in the metadata", async () => {
    const event = feeCollectedEvent("2500");

    await Promise.all([
      (worker as any).handleFeeCollected(event, event.topic[1]),
      (worker as any).handleFeeCollected(event, event.topic[1]),
    ]);

    const broadcast = vi.mocked(sseService.broadcastToAdmin);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenCalledWith(
      "stream.fee_collected",
      expect.objectContaining({ streamId: 777n, feeAmount: "2500" }),
    );

    // Exactly one row, and it carries both addresses the per-token totals group
    // by (see tests/fee-event-accounting.test.ts).
    expect(db.committed).toHaveLength(1);
    const metadata = JSON.parse(
      String((db.committed[0] as Record<string, string>).metadata),
    ) as { treasury: string; token: string };
    expect(metadata.treasury).toMatch(/^C/);
    expect(metadata.token).toMatch(/^C/);
    expect(metadata.treasury).not.toBe(metadata.token);
  });

  it("commits nothing when the transaction body fails partway through", async () => {
    const event = feeCollectedEvent("1500");

    mockPrismaObj.$transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          streamEvent: {
            findUnique: async () => null,
            upsert: async () => {
              throw new Error(
                "Unique constraint failed on the fields: (`transactionHash`,`eventType`)",
              );
            },
          },
        };
        await fn(tx);
        db.committed.push({ leaked: true });
      },
    );

    await expect(
      (worker as any).handleFeeCollected(event, event.topic[1]),
    ).rejects.toThrow(/Unique constraint failed/);

    // The failed batch wrote nothing, so an operator replay can still land the
    // fee row rather than colliding with a half-written one.
    expect(db.committed).toHaveLength(0);
  });
});
