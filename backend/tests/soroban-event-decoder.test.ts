import { describe, it, expect, vi, beforeEach } from 'vitest';
import { xdr, StrKey, rpc } from '@stellar/stellar-sdk';

const { mockPrismaObj, mockQuarantineEvent } = vi.hoisted(() => ({
  mockPrismaObj: {
    indexerState: {
      findUnique: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
    },
    user: {
      upsert: vi.fn(),
    },
    stream: {
      upsert: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    streamEvent: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
    },
    indexerDeadLetterEvent: {
      upsert: vi.fn(),
    },
    ledgerCheckpoint: {
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn((cb) =>
      cb({
        streamEvent: { findUnique: vi.fn(), upsert: vi.fn(), create: vi.fn() },
        user: { upsert: vi.fn() },
        stream: { upsert: vi.fn(), update: vi.fn() },
        $executeRaw: vi.fn().mockResolvedValue(1),
      })
    ),
    $disconnect: vi.fn(),
  },
  mockQuarantineEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/lib/prisma.js', () => ({
  default: mockPrismaObj,
  prisma: mockPrismaObj,
}));

vi.mock('../src/services/sse.service.js', () => ({
  sseService: {
    broadcastToStream: vi.fn(),
    broadcast: vi.fn(),
    broadcastToAdmin: vi.fn(),
  },
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  requestContext: {
    run: vi.fn((_ctx, fn) => fn()),
    getStore: vi.fn(() => ({ correlationId: 'test-correlation-id' })),
  },
}));

vi.mock('../src/services/indexerService.js', () => ({
  publishIndexerLag: vi.fn().mockResolvedValue(undefined),
  quarantineEvent: mockQuarantineEvent,
}));

import {
  decodeSymbol,
  decodeU64,
  decodeU32,
  decodeI128,
  decodeAddress,
  decodeMap,
  SorobanEventWorker,
} from '../src/workers/soroban-event-worker.js';

// Mock helpers matching the property access in decode* functions
const mockSym = (name: string) => ({ sym: { toString: () => name } } as any);
const mockU64 = (value: number | bigint | string) => ({ u64: { toString: () => String(value) } } as any);
const mockU32 = (n: number) => ({ u32: n } as any);
const mockI128 = (hi: number | bigint | string, lo: number | bigint | string) => ({
  i128: { hi: { toString: () => String(hi) }, lo: { toString: () => String(lo) } },
} as any);

const mockAccountAddr = (pubKey = 'GBEVJL4RM4IIUHWMB6N2X2LDYV5XEXR7GHCJ2GZCHP3FHLREX3W2TIIY') => ({
  address: {
    type: 'scAddressTypeAccount',
    accountId: { ed25519: { value: StrKey.decodeEd25519PublicKey(pubKey) } },
  },
} as any);

const mockContractAddr = (hexHash = '00'.repeat(32)) => ({
  address: {
    type: 'scAddressTypeContract',
    contractId: { value: Buffer.from(hexHash, 'hex') },
  },
} as any);

const mockMapEntry = (key: string, val: any) => ({ key: mockSym(key), val } as any);

describe('Issue #1757 - Malformed Soroban Event Decoding', () => {
  describe('Primitive and structural decoders', () => {
    it('decodeSymbol extracts string from ScValSymbol', () => {
      expect(decodeSymbol(mockSym('stream_created'))).toBe('stream_created');
      expect(decodeSymbol(mockSym(''))).toBe('');
    });

    it('decodeU64 handles 0, standard, and maximum unsigned 64-bit values', () => {
      expect(decodeU64(mockU64(0n))).toBe(0n);
      expect(decodeU64(mockU64(123456789n))).toBe(123456789n);
      const maxU64 = 18446744073709551615n;
      expect(decodeU64(mockU64(maxU64))).toBe(maxU64);
    });

    it('decodeU32 handles 0 and boundary values', () => {
      expect(decodeU32(mockU32(0))).toBe(0);
      expect(decodeU32(mockU32(4294967295))).toBe(4294967295);
    });

    it('decodeI128 correctly combines hi and lo 64-bit parts including signed hi', () => {
      // 0 hi, 500 lo
      expect(decodeI128(mockI128(0n, 500n))).toBe('500');

      // hi = 1, lo = 0 -> 1 * 2^64 = 18446744073709551616
      expect(decodeI128(mockI128(1n, 0n))).toBe('18446744073709551616');

      // negative hi: hi = -1, lo = 0 -> -2^64
      const negHi = BigInt.asIntN(64, -1n);
      const negVal = ((negHi << 64n) | 0n).toString();
      expect(decodeI128(mockI128(negHi, 0n))).toBe(negVal);
    });

    it('decodeAddress decodes account Ed25519 public keys and Contract IDs', () => {
      const pubKey = 'GBEVJL4RM4IIUHWMB6N2X2LDYV5XEXR7GHCJ2GZCHP3FHLREX3W2TIIY';
      expect(decodeAddress(mockAccountAddr(pubKey))).toBe(pubKey);

      const contractHash = 'a1'.repeat(32);
      const expectedContract = StrKey.encodeContract(Buffer.from(contractHash, 'hex'));
      expect(decodeAddress(mockContractAddr(contractHash))).toBe(expectedContract);
    });

    it('decodeAddress throws on unsupported ScAddress types', () => {
      const unsupportedAddr = {
        address: { type: 'scAddressTypeUnknown' },
      } as any;
      expect(() => decodeAddress(unsupportedAddr)).toThrow();
    });

    it('decodeMap returns empty record when map entries are null or missing', () => {
      expect(decodeMap({} as any)).toEqual({});
      expect(decodeMap({ map: null } as any)).toEqual({});
      expect(decodeMap({ map: [] } as any)).toEqual({});
    });

    it('decodeMap decodes valid ScMapEntry items into keyed records', () => {
      const mapVal = xdr.ScVal.scvMap([
        mockMapEntry('keyA', mockU64(10n)),
        mockMapEntry('keyB', mockSym('valueB')),
      ]);
      const res = decodeMap(mapVal);
      expect(decodeU64(res['keyA']!)).toBe(10n);
      expect(decodeSymbol(res['keyB']!)).toBe('valueB');
    });
  });

  describe('Event topic boundary handling in processEvent', () => {
    let worker: SorobanEventWorker;

    beforeEach(() => {
      vi.clearAllMocks();
      worker = new SorobanEventWorker();
    });

    it('gracefully ignores events with empty or missing topic array', async () => {
      const eventNoTopic: rpc.Api.EventResponse = {
        id: 'ev-1',
        type: 'contract',
        ledger: 100,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash: 'tx-1',
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [],
        value: xdr.ScVal.scvVoid(),
      };
      await expect(worker.processEvent(eventNoTopic)).resolves.toBeUndefined();

      const eventUndefinedTopic: rpc.Api.EventResponse = {
        ...eventNoTopic,
        topic: undefined as any,
      };
      await expect(worker.processEvent(eventUndefinedTopic)).resolves.toBeUndefined();
    });

    it('gracefully ignores events where topic[0] is missing', async () => {
      const eventMissingTopic0: rpc.Api.EventResponse = {
        id: 'ev-2',
        type: 'contract',
        ledger: 100,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash: 'tx-2',
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [undefined as any],
        value: xdr.ScVal.scvVoid(),
      };
      await expect(worker.processEvent(eventMissingTopic0)).resolves.toBeUndefined();
    });

    it('gracefully ignores events with unknown eventName in topic[0]', async () => {
      const eventUnknown: rpc.Api.EventResponse = {
        id: 'ev-3',
        type: 'contract',
        ledger: 100,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash: 'tx-3',
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('unknown_custom_event'), mockU64(1n)],
        value: xdr.ScVal.scvVoid(),
      };
      await expect(worker.processEvent(eventUnknown)).resolves.toBeUndefined();
    });

    it('gracefully ignores stream events when topic.length < 2', async () => {
      const eventMissingStreamIdTopic: rpc.Api.EventResponse = {
        id: 'ev-4',
        type: 'contract',
        ledger: 100,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash: 'tx-4',
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('stream_created')], // length 1 instead of >= 2
        value: xdr.ScVal.scvVoid(),
      };
      await expect(worker.processEvent(eventMissingStreamIdTopic)).resolves.toBeUndefined();
    });
  });

  describe('Missing body fields in event payloads', () => {
    let worker: SorobanEventWorker;

    beforeEach(() => {
      vi.clearAllMocks();
      worker = new SorobanEventWorker();
    });

    it('throws with descriptive error when stream_cancelled is missing amount_withdrawn or refunded_amount', async () => {
      const missingWithdrawnEvent: rpc.Api.EventResponse = {
        id: 'ev-cancel-fail-1',
        type: 'contract',
        ledger: 100,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash: 'tx-cancel-1',
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('stream_cancelled'), mockU64(99n)],
        value: xdr.ScVal.scvMap([
          mockMapEntry('refunded_amount', mockI128(0n, 1000n)),
          // missing amount_withdrawn
        ]),
      };

      await expect(worker.processEvent(missingWithdrawnEvent)).rejects.toThrow(
        /StreamCancelled #99: missing body fields/
      );

      const missingRefundedEvent: rpc.Api.EventResponse = {
        ...missingWithdrawnEvent,
        value: xdr.ScVal.scvMap([
          mockMapEntry('amount_withdrawn', mockI128(0n, 500n)),
          // missing refunded_amount
        ]),
      };

      await expect(worker.processEvent(missingRefundedEvent)).rejects.toThrow(
        /StreamCancelled #99: missing body fields/
      );
    });

    it('throws when stream_topped_up is missing amount or new_deposited_amount', async () => {
      const incompleteTopUp: rpc.Api.EventResponse = {
        id: 'ev-topup-fail',
        type: 'contract',
        ledger: 100,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash: 'tx-topup-1',
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('stream_topped_up'), mockU64(42n)],
        value: xdr.ScVal.scvMap([
          mockMapEntry('amount', mockI128(0n, 100n)),
          // missing new_deposited_amount
        ]),
      };

      await expect(worker.processEvent(incompleteTopUp)).rejects.toThrow();
    });

    it('throws when tokens_withdrawn is missing required fields', async () => {
      const incompleteWithdraw: rpc.Api.EventResponse = {
        id: 'ev-withdraw-fail',
        type: 'contract',
        ledger: 100,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash: 'tx-withdraw-1',
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('tokens_withdrawn'), mockU64(42n)],
        value: xdr.ScVal.scvMap([
          mockMapEntry('amount', mockI128(0n, 50n)),
          // missing recipient and timestamp
        ]),
      };

      await expect(worker.processEvent(incompleteWithdraw)).rejects.toThrow();
    });

    it('throws when stream_paused is missing sender or paused_at', async () => {
      const incompletePause: rpc.Api.EventResponse = {
        id: 'ev-pause-fail',
        type: 'contract',
        ledger: 100,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash: 'tx-pause-1',
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('stream_paused'), mockU64(42n)],
        value: xdr.ScVal.scvMap([
          mockMapEntry('sender', mockAccountAddr()),
          // missing paused_at
        ]),
      };

      await expect(worker.processEvent(incompletePause)).rejects.toThrow();
    });

    it('throws when stream_resumed is missing sender or new_end_time', async () => {
      const incompleteResume: rpc.Api.EventResponse = {
        id: 'ev-resume-fail',
        type: 'contract',
        ledger: 100,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash: 'tx-resume-1',
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('stream_resumed'), mockU64(42n)],
        value: xdr.ScVal.scvMap([
          mockMapEntry('sender', mockAccountAddr()),
          // missing new_end_time
        ]),
      };

      await expect(worker.processEvent(incompleteResume)).rejects.toThrow();
    });

    it('throws when fee_collected is missing treasury, fee_amount, or token', async () => {
      const incompleteFee: rpc.Api.EventResponse = {
        id: 'ev-fee-fail',
        type: 'contract',
        ledger: 100,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash: 'tx-fee-1',
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('fee_collected'), mockU64(42n)],
        value: xdr.ScVal.scvMap([
          mockMapEntry('treasury', mockAccountAddr()),
          // missing fee_amount and token
        ]),
      };

      await expect(worker.processEvent(incompleteFee)).rejects.toThrow();
    });
  });

  describe('Batch processing quarantine integration', () => {
    it('quarantines malformed event without crashing batch execution', async () => {
      const worker = new SorobanEventWorker();

      mockPrismaObj.indexerState.findUnique.mockResolvedValue({
        id: 'singleton',
        lastLedger: 1000,
        lastCursor: null,
        updatedAt: new Date(),
      });
      mockPrismaObj.indexerState.upsert.mockResolvedValue({
        id: 'singleton',
        lastLedger: 1001,
        lastCursor: 'c-1001',
        updatedAt: new Date(),
      });

      const malformedEvent: rpc.Api.EventResponse = {
        id: 'malformed-ev-1',
        type: 'contract',
        ledger: 1001,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash: 'tx-bad-1',
        transactionIndex: 0,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('stream_cancelled'), mockU64(101n)],
        value: xdr.ScVal.scvMap([]), // empty body -> triggers missing body fields
      };

      const validEvent: rpc.Api.EventResponse = {
        id: 'valid-ev-2',
        type: 'contract',
        ledger: 1001,
        ledgerClosedAt: '2026-01-01T00:00:00Z',
        txHash: 'tx-good-2',
        transactionIndex: 1,
        operationIndex: 0,
        inSuccessfulContractCall: true,
        topic: [mockSym('fee_config_updated')],
        value: xdr.ScVal.scvMap([
          mockMapEntry('basis_points', mockU32(25)),
          mockMapEntry('treasury_address', mockAccountAddr()),
        ]),
      };

      // Spy on processEvent to see individual calls
      const processSpy = vi.spyOn(worker, 'processEvent');

      // Mock getEvents to return both events in one response
      (worker as any).server = {
        getEvents: vi.fn().mockResolvedValue({
          events: [malformedEvent, validEvent],
          latestLedger: 1001,
          cursor: 'c-1001',
        }),
        getLatestLedger: vi.fn().mockResolvedValue({ sequence: 1001 }),
      };

      await (worker as any).fetchAndProcessEvents();

      // First event failed and got quarantined
      expect(mockQuarantineEvent).toHaveBeenCalledWith(
        malformedEvent,
        expect.any(Error)
      );

      // Second event succeeded
      expect(processSpy).toHaveBeenCalledWith(validEvent);

      // Indexer state was updated and advanced past the batch
      expect(mockPrismaObj.indexerState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'singleton' },
        })
      );
    });
  });
});
