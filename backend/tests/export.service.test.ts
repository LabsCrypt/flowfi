import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getProtocolFeeForEvent,
  mapEventToTransaction,
  streamTransactionCSV,
  streamTransactionJSON,
} from "../src/services/export.service.js";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    stream: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

describe("Export Service - Issues #1700 & #1701", () => {
  const userAddress = "GUSER1234567890ABCDEF1234567890ABCDEF1234567890";
  const counterparty = "GPARTY1234567890ABCDEF1234567890ABCDEF1234567890";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Issue #1700: Use indexed protocol fees in accounting exports", () => {
    it("reports zero fee on withdrawals and preserves exact net amount (no fabricated 0.5% fee)", () => {
      const withdrawalEvent = {
        eventType: "WITHDRAWN",
        amount: "10000000", // 1 token (7 decimals)
        transactionHash: "tx_withdrawn_1",
        timestamp: 1700000000n,
      };

      const stream = {
        streamId: 42n,
        sender: counterparty,
        recipient: userAddress,
        tokenAddress: "CDK...",
        events: [withdrawalEvent],
      };

      const fee = getProtocolFeeForEvent(withdrawalEvent, stream);
      expect(fee).toBe("0");

      const tx = mapEventToTransaction(withdrawalEvent, stream, userAddress);
      expect(tx.protocolFeeDeducted).toBe("0");
      expect(tx.grossAmountStroops).toBe("10000000");
      expect(tx.grossAmountFormatted).toBe("1.0000000");
      expect(tx.netAmount).toBe("1.0000000");
    });

    it("derives nonzero fee on stream creation from indexed FEE_COLLECTED event", () => {
      const createEvent = {
        eventType: "CREATED",
        amount: "10000000",
        transactionHash: "tx_create_1",
        timestamp: 1700000000n,
      };

      const feeEvent = {
        eventType: "FEE_COLLECTED",
        amount: "200000", // 0.02 token fee
        transactionHash: "tx_create_1",
        timestamp: 1700000000n,
      };

      const stream = {
        streamId: 42n,
        sender: userAddress,
        recipient: counterparty,
        tokenAddress: "CDK...",
        events: [createEvent, feeEvent],
      };

      const fee = getProtocolFeeForEvent(createEvent, stream);
      expect(fee).toBe("200000");

      const tx = mapEventToTransaction(createEvent, stream, userAddress);
      expect(tx.protocolFeeDeducted).toBe("200000");
      expect(tx.grossAmountFormatted).toBe("1.0000000");
      expect(tx.netAmount).toBe("0.9800000"); // 10000000 - 200000 = 9800000
    });

    it("derives fee from metadata if indexed FEE_COLLECTED event is not in stream events", () => {
      const topUpEvent = {
        eventType: "TOPPED_UP",
        amount: "5000000",
        transactionHash: "tx_topup_1",
        timestamp: 1700000100n,
        metadata: JSON.stringify({ feeAmount: "50000" }),
      };

      const stream = {
        streamId: 42n,
        sender: userAddress,
        recipient: counterparty,
        tokenAddress: "CDK...",
        events: [topUpEvent],
      };

      const fee = getProtocolFeeForEvent(topUpEvent, stream);
      expect(fee).toBe("50000");

      const tx = mapEventToTransaction(topUpEvent, stream, userAddress);
      expect(tx.protocolFeeDeducted).toBe("50000");
      expect(tx.netAmount).toBe("0.4950000");
    });
  });

  describe("Issue #1701: Terminate accounting export responses after streaming errors", () => {
    function createMockResponse() {
      const res: any = {
        headersSent: false,
        statusCode: 200,
        headers: {},
        writtenChunks: [] as string[],
        ended: false,
        destroyed: false,
        destroyError: null as any,
        setHeader: vi.fn((key: string, val: string) => {
          res.headers[key] = val;
        }),
        status: vi.fn((code: number) => {
          res.statusCode = code;
          return res;
        }),
        json: vi.fn((data: any) => {
          res.jsonData = data;
          res.ended = true;
          return res;
        }),
        write: vi.fn((chunk: string) => {
          res.headersSent = true;
          res.writtenChunks.push(chunk);
          return true;
        }),
        end: vi.fn(() => {
          res.ended = true;
        }),
        destroy: vi.fn((err?: any) => {
          res.destroyed = true;
          res.destroyError = err;
        }),
      };
      return res;
    }

    it("terminates CSV export with res.destroy when database fails after headersSent", async () => {
      const mockRes = createMockResponse();

      // In the loop, findMany throws an error
      prismaMock.stream.findMany.mockRejectedValueOnce(new Error("Database connection dropped mid-stream"));

      await streamTransactionCSV(userAddress, { format: "csv", direction: "all" }, mockRes);

      expect(mockRes.headersSent).toBe(true); // res.write(CSV_HEADERS) happened
      expect(mockRes.destroyed).toBe(true);
      expect(mockRes.destroyError?.message).toBe("Database connection dropped mid-stream");
    });

    it("terminates JSON export with res.destroy when database fails after headersSent", async () => {
      const mockRes = createMockResponse();

      prismaMock.stream.findMany.mockRejectedValueOnce(new Error("Database error mid-json"));

      await streamTransactionJSON(userAddress, { format: "json", direction: "all" }, mockRes);

      expect(mockRes.headersSent).toBe(true); // res.write('{"transactions":[') happened
      expect(mockRes.destroyed).toBe(true);
      expect(mockRes.destroyError?.message).toBe("Database error mid-json");
    });

    it("handles fallback to res.end() if res.destroy is unavailable", async () => {
      const mockRes = createMockResponse();
      delete mockRes.destroy;

      prismaMock.stream.findMany.mockRejectedValueOnce(new Error("DB error"));

      await streamTransactionCSV(userAddress, { format: "csv", direction: "all" }, mockRes);

      expect(mockRes.headersSent).toBe(true);
      expect(mockRes.ended).toBe(true);
    });
  });
});
