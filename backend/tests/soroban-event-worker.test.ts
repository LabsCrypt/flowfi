import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { xdr, Keypair, StrKey, nativeToScVal } from '@stellar/stellar-sdk';

// ─── Mock Prisma ─────────────────────────────────────────────────────────────

const mockTx = {
  user: { upsert: vi.fn().mockResolvedValue({}) },
  stream: {
    upsert: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    findUniqueOrThrow: vi.fn().mockResolvedValue({ withdrawnAmount: '0' }),
  },
  streamEvent: { create: vi.fn().mockResolvedValue({}) },
};

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<void>) => fn(mockTx)),
    indexerState: { upsert: vi.fn().mockResolvedValue({ id: 'singleton', lastLedger: 0, lastCursor: null }) },
    streamEvent: { create: vi.fn().mockResolvedValue({}) },
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1n }]),
    $disconnect: vi.fn(),
  },
}));

vi.mock('../src/services/sse.service.js', () => ({
  sseService: {
    broadcastToStream: vi.fn(),
    broadcast: vi.fn(),
  },
}));

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  decodeU64,
  decodeI128,
  decodeAddress,
  decodeMap,
  SorobanEventWorker,
} from '../src/workers/soroban-event-worker.js';
import { sseService } from '../src/services/sse.service.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build ScVal U64 from a bigint */
function scvU64(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: 'u64' });
}

/** Build ScVal I128 from a bigint */
function scvI128(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: 'i128' });
}

/** Build ScVal Address from a G... public key string */
function scvAccountAddress(publicKey: string): xdr.ScVal {
  return nativeToScVal(publicKey, { type: 'address' });
}

/** Build ScVal Address from a C... contract ID string */
function scvContractAddress(contractId: string): xdr.ScVal {
  return nativeToScVal(contractId, { type: 'address' });
}

/** Build ScVal Symbol */
function scvSymbol(s: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(s);
}

/** Build ScVal Map from key-value pairs */
function scvMap(entries: [string, xdr.ScVal][]): xdr.ScVal {
  return xdr.ScVal.scvMap(
    entries.map(([k, v]) =>
      new xdr.ScMapEntry({ key: scvSymbol(k), val: v }),
    ),
  );
}

// Known test keys
const SENDER_KP = Keypair.random();
const RECIPIENT_KP = Keypair.random();
const SENDER_PUB = SENDER_KP.publicKey();
const RECIPIENT_PUB = RECIPIENT_KP.publicKey();
// Generate a valid C... address from 32 random bytes
const CONTRACT_HASH = Buffer.alloc(32, 0xab);
const CONTRACT_ADDR = StrKey.encodeContract(CONTRACT_HASH);

// ─── decodeU64 ───────────────────────────────────────────────────────────────

describe('decodeU64', () => {
  it('decodes zero', () => {
    expect(decodeU64(scvU64(0n))).toBe(0n);
  });

  it('decodes a typical value', () => {
    expect(decodeU64(scvU64(1_700_000_000n))).toBe(1_700_000_000n);
  });

  it('decodes max u64 value (2^64 - 1)', () => {
    const maxU64 = (1n << 64n) - 1n;
    expect(decodeU64(scvU64(maxU64))).toBe(maxU64);
  });
});

// ─── decodeI128 ──────────────────────────────────────────────────────────────

describe('decodeI128', () => {
  it('decodes positive value', () => {
    expect(decodeI128(scvI128(1_000_000_000n))).toBe('1000000000');
  });

  it('decodes negative value', () => {
    expect(decodeI128(scvI128(-42n))).toBe('-42');
  });

  it('decodes zero', () => {
    expect(decodeI128(scvI128(0n))).toBe('0');
  });

  it('decodes max i128 (2^127 - 1)', () => {
    const maxI128 = (1n << 127n) - 1n;
    expect(decodeI128(scvI128(maxI128))).toBe(maxI128.toString());
  });

  it('decodes min i128 (-(2^127))', () => {
    const minI128 = -(1n << 127n);
    expect(decodeI128(scvI128(minI128))).toBe(minI128.toString());
  });

  it('decodes large value that exercises hi word', () => {
    // A value larger than 2^64 so the hi word is non-zero
    const large = (1n << 64n) + 999n;
    expect(decodeI128(scvI128(large))).toBe(large.toString());
  });
});

// ─── decodeAddress ───────────────────────────────────────────────────────────

describe('decodeAddress', () => {
  it('decodes a G... account address', () => {
    const result = decodeAddress(scvAccountAddress(SENDER_PUB));
    expect(result).toBe(SENDER_PUB);
    expect(result).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it('decodes a C... contract address', () => {
    const result = decodeAddress(scvContractAddress(CONTRACT_ADDR));
    expect(result).toBe(CONTRACT_ADDR);
    expect(result).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it('round-trips a random keypair address', () => {
    const kp = Keypair.random();
    expect(decodeAddress(scvAccountAddress(kp.publicKey()))).toBe(kp.publicKey());
  });
});

// ─── decodeMap ───────────────────────────────────────────────────────────────

describe('decodeMap', () => {
  it('decodes a map with multiple fields', () => {
    const val = scvMap([
      ['sender', scvAccountAddress(SENDER_PUB)],
      ['amount', scvI128(500n)],
    ]);
    const result = decodeMap(val);
    expect(Object.keys(result)).toEqual(['sender', 'amount']);
    // Values should be raw ScVal objects
    expect(result['sender']).toBeDefined();
    expect(result['amount']).toBeDefined();
  });

  it('returns empty object for null map', () => {
    // ScVal with an empty map
    const val = xdr.ScVal.scvMap([]);
    const result = decodeMap(val);
    expect(result).toEqual({});
  });
});

// ─── Event handler helpers ───────────────────────────────────────────────────

function makeWorker(): SorobanEventWorker {
  // Set env so constructor doesn't bail
  process.env.STREAM_CONTRACT_ID = 'CCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  return new SorobanEventWorker();
}

function fakeEvent(
  eventName: string,
  streamId: bigint,
  bodyEntries: [string, xdr.ScVal][],
): { event: any; topic0: xdr.ScVal; topic1: xdr.ScVal } {
  const topic0 = scvSymbol(eventName);
  const topic1 = scvU64(streamId);
  const value = scvMap(bodyEntries);
  return {
    event: {
      id: `evt-${eventName}-${streamId}`,
      type: 'contract',
      ledger: 12345,
      txHash: 'abc123def456',
      topic: [topic0, topic1],
      value,
      inSuccessfulContractCall: true,
    },
    topic0,
    topic1,
  };
}

// ─── handleStreamCreated ─────────────────────────────────────────────────────

describe('handleStreamCreated', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('writes correct DB record via mocked Prisma', async () => {
    const worker = makeWorker();
    const { event, topic1 } = fakeEvent('stream_created', 42n, [
      ['sender', scvAccountAddress(SENDER_PUB)],
      ['recipient', scvAccountAddress(RECIPIENT_PUB)],
      ['token_address', scvContractAddress(CONTRACT_ADDR)],
      ['rate_per_second', scvI128(100n)],
      ['deposited_amount', scvI128(86400n)],
      ['start_time', scvU64(1700000000n)],
    ]);

    await (worker as any).handleStreamCreated(event, topic1);

    // Verify user upserts for sender & recipient
    expect(mockTx.user.upsert).toHaveBeenCalledTimes(2);
    expect(mockTx.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { publicKey: SENDER_PUB } }),
    );
    expect(mockTx.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { publicKey: RECIPIENT_PUB } }),
    );

    // Verify stream upsert
    expect(mockTx.stream.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId: 42 },
        create: expect.objectContaining({
          streamId: 42,
          sender: SENDER_PUB,
          recipient: RECIPIENT_PUB,
          tokenAddress: CONTRACT_ADDR,
          ratePerSecond: '100',
          depositedAmount: '86400',
          withdrawnAmount: '0',
          startTime: 1700000000,
          isActive: true,
        }),
      }),
    );

    // Verify streamEvent creation
    expect(mockTx.streamEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          streamId: 42,
          eventType: 'CREATED',
          amount: '86400',
          transactionHash: 'abc123def456',
        }),
      }),
    );

    // Verify SSE broadcast
    expect(sseService.broadcastToStream).toHaveBeenCalledWith(
      '42',
      'stream.created',
      expect.objectContaining({ streamId: 42, sender: SENDER_PUB }),
    );
  });
});

// ─── handleStreamToppedUp ────────────────────────────────────────────────────

describe('handleStreamToppedUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T12:34:56Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('updates deposited amount', async () => {
    const worker = makeWorker();
    const { event, topic1 } = fakeEvent('stream_topped_up', 7n, [
      ['amount', scvI128(5000n)],
      ['new_deposited_amount', scvI128(91400n)],
    ]);

    await (worker as any).handleStreamToppedUp(event, topic1);

    expect(mockTx.stream.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId: 7 },
        data: expect.objectContaining({
          depositedAmount: '91400',
          lastUpdateTime: 1_777_379_696,
        }),
      }),
    );

    expect(mockTx.streamEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          streamId: 7,
          eventType: 'TOPPED_UP',
          amount: '5000',
        }),
      }),
    );

    expect(sseService.broadcastToStream).toHaveBeenCalledWith(
      '7',
      'stream.topped_up',
      expect.objectContaining({
        streamId: 7,
        amount: '5000',
        timestamp: 1_777_379_696,
      }),
    );
  });
});

// ─── handleStreamCancelled ───────────────────────────────────────────────────

describe('handleStreamCancelled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T12:34:56Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('sets isActive to false', async () => {
    const worker = makeWorker();
    const { event, topic1 } = fakeEvent('stream_cancelled', 99n, [
      ['amount_withdrawn', scvI128(300n)],
      ['refunded_amount', scvI128(700n)],
    ]);

    await (worker as any).handleStreamCancelled(event, topic1);

    expect(mockTx.stream.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId: 99 },
        data: expect.objectContaining({
          isActive: false,
          withdrawnAmount: '300',
          lastUpdateTime: 1_777_379_696,
        }),
      }),
    );

    expect(mockTx.streamEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          streamId: 99,
          eventType: 'CANCELLED',
          amount: '700',
        }),
      }),
    );
  });
});

// ─── handleStreamPaused ──────────────────────────────────────────────────────

describe('handleStreamPaused', () => {
  const worker = makeWorker() as any;

  if (typeof worker.handleStreamPaused !== 'function') {
    it.todo('sets isPaused once the paused handler is added');
    return;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T12:34:56Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('sets isPaused', async () => {
    const { event, topic1 } = fakeEvent('stream_paused', 77n, []);

    await worker.handleStreamPaused(event, topic1);

    expect(mockTx.stream.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId: 77 },
        data: expect.objectContaining({
          isPaused: true,
          lastUpdateTime: 1_777_379_696,
        }),
      }),
    );
  });
});

// ─── Unknown event type ──────────────────────────────────────────────────────

describe('processEvent (unknown type)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('silently ignores unknown event types without DB writes', async () => {
    const worker = makeWorker();
    const { event } = fakeEvent('some_future_event', 1n, [
      ['foo', scvI128(1n)],
    ]);

    // processEvent is private — access via any
    await (worker as any).processEvent(event);

    expect(mockTx.stream.upsert).not.toHaveBeenCalled();
    expect(mockTx.stream.update).not.toHaveBeenCalled();
    expect(mockTx.streamEvent.create).not.toHaveBeenCalled();
    expect(sseService.broadcastToStream).not.toHaveBeenCalled();
  });

  it('ignores events with fewer than 2 topics', async () => {
    const worker = makeWorker();
    const event = {
      id: 'evt-short',
      type: 'contract',
      ledger: 1,
      txHash: 'tx1',
      topic: [scvSymbol('stream_created')], // only 1 topic
      value: scvMap([]),
      inSuccessfulContractCall: true,
    };

    await (worker as any).processEvent(event);
    expect(mockTx.stream.upsert).not.toHaveBeenCalled();
  });
});
