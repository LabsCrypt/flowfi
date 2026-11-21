/**
 * Issue #1764 — deterministic coverage for the FeeCollected accounting path in
 * `src/workers/soroban-event-worker.ts`.
 *
 * The existing worker suite drives `handleFeeCollected` with one happy event and
 * the admin metrics suite sums whatever the database hands back. Neither pins the
 * decode step — where a fee event stops being XDR and becomes the `amount` and
 * `metadata.token` values the per-token fee totals are grouped from. So this file
 * covers, against real XDR built with `nativeToScVal`:
 *   - the integer boundaries of the decoders (the full i128 range, the hi/lo
 *     composition around 2^64, values past `Number.MAX_SAFE_INTEGER`, u64 max),
 *   - address decoding for both account and contract forms,
 *   - the documented failure path (`missing body fields`) and what it must not do
 *     (no transaction, no row, no broadcast),
 *   - dependency failures (database down, write rejected) surfacing as errors
 *     instead of being reported as a processed fee,
 *   - the exact values the downstream `GROUP BY token` fee sum depends on.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";

const mockTx = vi.hoisted(() => ({
  streamEvent: { findUnique: vi.fn(), upsert: vi.fn(), create: vi.fn() },
  stream: { upsert: vi.fn(), update: vi.fn() },
  user: { upsert: vi.fn() },
}));

const mockPrismaObj = vi.hoisted(() => ({
  ...mockTx,
  indexerState: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
  ledgerCheckpoint: { findMany: vi.fn(), upsert: vi.fn() },
  indexerDeadLetterEvent: { upsert: vi.fn() },
  $transaction: vi.fn(),
  $disconnect: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  default: mockPrismaObj,
  prisma: mockPrismaObj,
}));

vi.mock("../src/services/sse.service.js", () => ({
  sseService: {
    broadcastToStream: vi.fn(),
    broadcast: vi.fn(),
    broadcastToAdmin: vi.fn(),
  },
  SSEService: vi.fn(() => ({})),
}));

vi.mock("../src/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/logger.js")>();
  return {
    ...actual,
    default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

import {
  SorobanEventWorker,
  decodeI128,
  decodeU64,
  decodeU32,
  decodeAddress,
  decodeMap,
  decodeSymbol,
  getEventLedgerTimestamp,
} from "../src/workers/soroban-event-worker.js";
import { sseService } from "../src/services/sse.service.js";
import logger from "../src/logger.js";

// ─── Real XDR helpers ───────────────────────────────────────────────────────

const scvU64 = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: "u64" });
const scvI128 = (value: bigint): xdr.ScVal => nativeToScVal(value, { type: "i128" });
const scvAddress = (strkey: string): xdr.ScVal => nativeToScVal(strkey, { type: "address" });

const I128_MAX = 170141183460469231731687303715884105727n;
const I128_MIN = -170141183460469231731687303715884105728n;
const U64_MAX = 18446744073709551615n;
const TWO_POW_64 = 18446744073709551616n;

const TREASURY = Keypair.random().publicKey();
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 5));
const STREAM_ID = 7n;

function feeCollectedEvent(
  body: Record<string, xdr.ScVal>,
  txHash = "fee-tx-hash",
): rpc.Api.EventResponse {
  return {
    id: "fee-event-1",
    type: "contract",
    ledger: 1234,
    ledgerClosedAt: "1700000000",
    txHash,
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    topic: [xdr.ScVal.scvSymbol("FeeCollected"), scvU64(STREAM_ID)],
    value: xdr.ScVal.scvMap(
      Object.entries(body).map(
        ([key, val]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val }),
      ),
    ),
  } as unknown as rpc.Api.EventResponse;
}

function completeFeeBody(): Record<string, xdr.ScVal> {
  return {
    treasury: scvAddress(TREASURY),
    fee_amount: scvI128(2_500_000_000n),
    token: scvAddress(TOKEN),
  };
}

describe("i128 decoding (fee amounts)", () => {
  it("reads zero, one and minus one as exact decimal strings", () => {
    for (const value of [0n, 1n, -1n]) {
      expect(decodeI128(scvI128(value))).toBe(value.toString());
    }
  });

  it("reads the full i128 range without losing digits", () => {
    expect(decodeI128(scvI128(I128_MAX))).toBe(I128_MAX.toString());
    expect(decodeI128(scvI128(I128_MIN))).toBe(I128_MIN.toString());
  });

  it("composes the signed hi and unsigned lo halves at 2^64", () => {
    // The largest value the low half alone carries, then exactly 2^64, then one
    // past it. A decoder that adds instead of shifts — or reads lo as signed —
    // is wrong on only one side of this boundary.
    expect(decodeI128(scvI128(U64_MAX))).toBe(U64_MAX.toString());
    expect(decodeI128(scvI128(TWO_POW_64))).toBe(TWO_POW_64.toString());
    expect(decodeI128(scvI128(TWO_POW_64 + 1n))).toBe("18446744073709551617");
  });

  it("decodes negatives whose low half is full", () => {
    // -1 and -2^64 both carry hi = -1 with different lows; neither may come back
    // as a huge positive.
    expect(decodeI128(scvI128(-1n))).toBe("-1");
    expect(decodeI128(scvI128(-TWO_POW_64))).toBe("-18446744073709551616");
    expect(decodeI128(scvI128(-123_456_789_012_345_678_901n))).toBe(
      "-123456789012345678901",
    );
  });

  it("stays exact past Number.MAX_SAFE_INTEGER, where a Number decode drifts", () => {
    const beyondSafe = 9_007_199_254_740_993n; // 2^53 + 1
    const decoded = decodeI128(scvI128(beyondSafe));

    expect(decoded).toBe("9007199254740993");
    expect(BigInt(decoded)).toBe(beyondSafe);
    // The guard against a regression that narrows the decode to a Number:
    // 2^53 + 1 is not representable, so it would round the last digit off.
    expect(String(Number(beyondSafe))).not.toBe(decoded);
  });

  it("rejects a value outside the i128 range instead of wrapping it", () => {
    expect(() => scvI128(I128_MAX + 1n)).toThrow();
    expect(() => scvI128(I128_MIN - 1n)).toThrow();
  });
});

describe("u64, u32, symbol and map decoding", () => {
  it("returns u64 as a BigInt across its range", () => {
    expect(decodeU64(scvU64(0n))).toBe(0n);
    expect(decodeU64(scvU64(U64_MAX))).toBe(U64_MAX);
    expect(typeof decodeU64(scvU64(U64_MAX))).toBe("bigint");
  });

  it("rejects a u64 outside its range", () => {
    expect(() => scvU64(-1n)).toThrow();
    expect(() => scvU64(U64_MAX + 1n)).toThrow();
  });

  it("reads u32 as a number at both ends", () => {
    expect(decodeU32(nativeToScVal(0, { type: "u32" }))).toBe(0);
    expect(decodeU32(nativeToScVal(4_294_967_295, { type: "u32" }))).toBe(4_294_967_295);
  });

  it("reads a symbol by name", () => {
    expect(decodeSymbol(xdr.ScVal.scvSymbol("FeeCollected"))).toBe("FeeCollected");
  });

  it("keys a map struct by field name and keeps the raw values", () => {
    const body = decodeMap(
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("treasury"), val: scvU64(1n) }),
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("token"), val: scvU64(2n) }),
      ]),
    );

    expect(Object.keys(body)).toEqual(["treasury", "token"]);
    expect(decodeU64(body["treasury"]!)).toBe(1n);
    expect(decodeU64(body["token"]!)).toBe(2n);
  });

  it("returns an empty object for a map with no entries", () => {
    expect(decodeMap(xdr.ScVal.scvMap([]))).toEqual({});
  });
});

describe("address decoding", () => {
  it("encodes an account address as the same G... key that went in", () => {
    const decoded = decodeAddress(scvAddress(TREASURY));

    expect(decoded).toBe(TREASURY);
    expect(StrKey.isValidEd25519PublicKey(decoded)).toBe(true);
  });

  it("encodes a contract address as the same C... key that went in", () => {
    const decoded = decodeAddress(scvAddress(TOKEN));

    expect(decoded).toBe(TOKEN);
    expect(StrKey.isValidContract(decoded)).toBe(true);
  });

  it("keeps an account and a contract built from the same 32 bytes distinct", () => {
    // Both forms carry a 32-byte body, so a decoder that ignores the
    // discriminant reports one address for both — and the per-token fee grouping
    // would collapse every token into the treasury key.
    const bytes = Buffer.alloc(32, 9);
    const asAccount = StrKey.encodeEd25519PublicKey(bytes);
    const asContract = StrKey.encodeContract(bytes);

    expect(decodeAddress(scvAddress(asAccount))).toBe(asAccount);
    expect(decodeAddress(scvAddress(asContract))).toBe(asContract);
    expect(decodeAddress(scvAddress(asAccount))).not.toBe(decodeAddress(scvAddress(asContract)));
  });
});

describe("ledger close time", () => {
  it("uses ledgerClosedAt when it is a sane integer", () => {
    expect(getEventLedgerTimestamp({ ledgerClosedAt: "1700000000" })).toBe(1700000000);
    expect(getEventLedgerTimestamp({ ledgerClosedAt: "0" })).toBe(0);
  });

  it("falls back to the current time for absent or unusable values", () => {
    const before = Math.floor(Date.now() / 1000);

    expect(getEventLedgerTimestamp({ ledgerClosedAt: "-5" })).toBeGreaterThanOrEqual(before);
    expect(getEventLedgerTimestamp({ ledgerClosedAt: "not-a-time" })).toBeGreaterThanOrEqual(
      before,
    );
    expect(getEventLedgerTimestamp({} as never)).toBeGreaterThanOrEqual(before);
  });
});

describe("handleFeeCollected — documented success path", () => {
  let worker: SorobanEventWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrismaObj.$transaction.mockImplementation((cb: any) => cb(mockTx));
    mockTx.streamEvent.findUnique.mockResolvedValue(null);
    mockTx.streamEvent.upsert.mockResolvedValue({ id: "fee-event-1" });
    worker = new SorobanEventWorker();
  });

  it("writes the stream id, the exact amount and the token metadata in one transaction", async () => {
    const event = feeCollectedEvent(completeFeeBody());

    await (worker as any).handleFeeCollected(event, event.topic![1]);

    expect(mockPrismaObj.$transaction).toHaveBeenCalledTimes(1);
    expect(mockTx.streamEvent.upsert).toHaveBeenCalledTimes(1);

    const call = mockTx.streamEvent.upsert.mock.calls[0]![0];
    expect(call.where).toEqual({
      transactionHash_eventType: { transactionHash: "fee-tx-hash", eventType: "FEE_COLLECTED" },
    });
    expect(call.create).toMatchObject({
      streamId: STREAM_ID,
      eventType: "FEE_COLLECTED",
      amount: "2500000000",
      transactionHash: "fee-tx-hash",
      ledgerSequence: 1234,
    });
    // The admin fee totals group on metadata->>'token', so the token has to land
    // as the decoded contract address — the same string the SSE payload reports.
    expect(JSON.parse(call.create.metadata as string)).toEqual({
      treasury: TREASURY,
      token: TOKEN,
    });
  });

  it("keeps an amount past the safe-integer range exact through to the broadcast", async () => {
    const huge = 9_007_199_254_740_993n;
    const event = feeCollectedEvent({ ...completeFeeBody(), fee_amount: scvI128(huge) });

    await (worker as any).handleFeeCollected(event, event.topic![1]);

    expect(mockTx.streamEvent.upsert.mock.calls[0]![0].create.amount).toBe(huge.toString());
    const broadcast = (
      sseService.broadcastToAdmin as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0]!;
    expect(broadcast[0]).toBe("stream.fee_collected");
    expect(broadcast[1]).toMatchObject({
      streamId: STREAM_ID,
      feeAmount: huge.toString(),
      token: TOKEN,
      ledger: 1234,
    });
  });

  it("carries an i128 extreme through untruncated, which is what SUM depends on", async () => {
    const event = feeCollectedEvent({ ...completeFeeBody(), fee_amount: scvI128(I128_MAX) });

    await (worker as any).handleFeeCollected(event, event.topic![1]);

    expect(mockTx.streamEvent.upsert.mock.calls[0]![0].create.amount).toBe(I128_MAX.toString());
  });

  it("skips the write and warns when the same event is delivered twice", async () => {
    const event = feeCollectedEvent(completeFeeBody());
    mockTx.streamEvent.findUnique.mockResolvedValueOnce({ id: "already-there" });

    await (worker as any).handleFeeCollected(event, event.topic![1]);

    expect(mockTx.streamEvent.upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Duplicate StreamEvent skipped"),
    );
    expect(sseService.broadcastToAdmin).toHaveBeenCalledTimes(1);
  });
});

describe("handleFeeCollected — failure paths", () => {
  let worker: SorobanEventWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrismaObj.$transaction.mockImplementation((cb: any) => cb(mockTx));
    mockTx.streamEvent.findUnique.mockResolvedValue(null);
    mockTx.streamEvent.upsert.mockResolvedValue({ id: "fee-event-1" });
    worker = new SorobanEventWorker();
  });

  for (const missing of ["treasury", "fee_amount", "token"]) {
    it(`rejects a body without ${missing} and writes nothing`, async () => {
      const body = completeFeeBody();
      delete (body as Record<string, unknown>)[missing];
      const event = feeCollectedEvent(body);

      await expect((worker as any).handleFeeCollected(event, event.topic![1])).rejects.toThrow(
        "FeeCollected #7: missing body fields",
      );

      expect(mockPrismaObj.$transaction).not.toHaveBeenCalled();
      expect(mockTx.streamEvent.upsert).not.toHaveBeenCalled();
      expect(sseService.broadcastToAdmin).not.toHaveBeenCalled();
    });
  }

  it("lets a database failure surface instead of reporting a processed fee", async () => {
    const event = feeCollectedEvent(completeFeeBody());
    const dbDown = new Error("connection refused");
    mockPrismaObj.$transaction.mockRejectedValueOnce(dbDown);

    await expect((worker as any).handleFeeCollected(event, event.topic![1])).rejects.toThrow(
      dbDown,
    );

    expect(sseService.broadcastToAdmin).not.toHaveBeenCalled();
  });

  it("does not broadcast when the write inside the transaction fails", async () => {
    const event = feeCollectedEvent(completeFeeBody());
    mockTx.streamEvent.upsert.mockRejectedValueOnce(new Error("unique constraint"));

    await expect((worker as any).handleFeeCollected(event, event.topic![1])).rejects.toThrow(
      "unique constraint",
    );

    expect(sseService.broadcastToAdmin).not.toHaveBeenCalled();
  });
});
