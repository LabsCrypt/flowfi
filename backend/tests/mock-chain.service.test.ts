import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrismaObj = vi.hoisted(() => ({
  stream: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    aggregate: vi.fn(),
  },
  streamEvent: {
    upsert: vi.fn(),
  },
  user: {
    findMany: vi.fn(),
  },
  $executeRawUnsafe: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  default: mockPrismaObj,
  prisma: mockPrismaObj,
}));

const sseMocks = vi.hoisted(() => ({ broadcastToStream: vi.fn() }));
const broadcastToStream = sseMocks.broadcastToStream;

vi.mock('../src/services/sse.service.js', () => ({
  sseService: {
    broadcastToStream: sseMocks.broadcastToStream,
    broadcast: vi.fn(),
    broadcastToUser: vi.fn(),
  },
}));

import {
  applyMockAction,
  pauseStream,
  resumeStream,
  cancel,
  mockTransactionHash,
} from '../src/services/mock-chain.service.js';
import { ApiError } from '../src/lib/api-error.js';

const SENDER = 'GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH';
const RECIPIENT = 'GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3XKSOLXAUJSD56C4LHND5TWUC';

function streamRow(overrides: Record<string, unknown> = {}) {
  return {
    streamId: 900_001n,
    sender: SENDER,
    recipient: RECIPIENT,
    tokenAddress: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    ratePerSecond: '1000000',
    depositedAmount: '1000000000',
    withdrawnAmount: '0',
    startTime: 1_700_000_000n,
    lastUpdateTime: 1_700_000_000n,
    isActive: true,
    isPaused: false,
    pausedAt: null,
    totalPausedDuration: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrismaObj.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      $executeRawUnsafe: mockPrismaObj.$executeRawUnsafe,
      stream: mockPrismaObj.stream,
    }),
  );
});

describe('mockTransactionHash', () => {
  it('is a deterministic 64-char hex string shaped like a Stellar hash', () => {
    const hash = mockTransactionHash('pause_stream', 1n);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('pauseStream', () => {
  it('rejects a caller who is not the sender', async () => {
    mockPrismaObj.stream.findUnique.mockResolvedValue(streamRow());

    await expect(pauseStream(900_001n, RECIPIENT)).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(mockPrismaObj.stream.update).not.toHaveBeenCalled();
  });

  it('records the pause, writes a PAUSED event and broadcasts', async () => {
    mockPrismaObj.stream.findUnique.mockResolvedValue(streamRow());

    const result = await pauseStream(900_001n, SENDER);

    expect(result.success).toBe(true);
    expect(result.streamId).toBe('900001');
    expect(mockPrismaObj.stream.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { streamId: 900_001n },
        data: expect.objectContaining({ isPaused: true }),
      }),
    );
    expect(mockPrismaObj.streamEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ eventType: 'PAUSED' }),
      }),
    );
    expect(broadcastToStream).toHaveBeenCalledWith(
      '900001',
      'stream.paused',
      expect.objectContaining({ mock: true }),
    );
  });

  it('refuses to pause an already-paused stream', async () => {
    mockPrismaObj.stream.findUnique.mockResolvedValue(streamRow({ isPaused: true }));

    await expect(pauseStream(900_001n, SENDER)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses to pause a cancelled stream — cancellation is permanent', async () => {
    mockPrismaObj.stream.findUnique.mockResolvedValue(streamRow({ isActive: false }));

    await expect(pauseStream(900_001n, SENDER)).rejects.toMatchObject({
      status: 409,
    });
    await expect(resumeStream(900_001n, SENDER)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('resumeStream', () => {
  it('clears the pause and accumulates the paused duration', async () => {
    const pausedAt = BigInt(Math.floor(Date.now() / 1000)) - 3600n;
    mockPrismaObj.stream.findUnique.mockResolvedValue(
      streamRow({ isPaused: true, pausedAt, lastUpdateTime: pausedAt }),
    );

    const result = await resumeStream(900_001n, SENDER);

    expect(result.success).toBe(true);
    const update = mockPrismaObj.stream.update.mock.calls[0]?.[0] as {
      data: { isPaused: boolean; pausedAt: null; totalPausedDuration: { increment: number } };
    };
    expect(update.data.isPaused).toBe(false);
    expect(update.data.pausedAt).toBeNull();
    expect(update.data.totalPausedDuration.increment).toBeGreaterThanOrEqual(3_590);
  });

  it('refuses to resume a stream that is not paused', async () => {
    mockPrismaObj.stream.findUnique.mockResolvedValue(streamRow());

    await expect(resumeStream(900_001n, SENDER)).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('withdraw', () => {
  it('only lets the recipient withdraw', async () => {
    mockPrismaObj.stream.findUnique.mockResolvedValue(
      // lastUpdateTime in the past so there is a claimable balance.
      streamRow({ lastUpdateTime: BigInt(Math.floor(Date.now() / 1000) - 86_400) }),
    );

    await expect(
      applyMockAction('withdraw', SENDER, { streamId: '900001' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('deposits the claimable amount and emits COMPLETED once drained', async () => {
    const deposited = 1_000_000_000n;
    mockPrismaObj.stream.findUnique.mockResolvedValue(
      streamRow({
        depositedAmount: deposited.toString(),
        // Draining this amount requires remaining == streamed, so the post
        // update read reports a fully drained stream.
        withdrawnAmount: (deposited - 86_400_000_000n).toString(),
        ratePerSecond: '1000000',
      }),
    );
    mockPrismaObj.stream.findUnique
      .mockResolvedValueOnce(
        streamRow({
          depositedAmount: deposited.toString(),
          withdrawnAmount: (deposited - 86_400_000_000n).toString(),
          ratePerSecond: '1000000',
        }),
      )
      .mockResolvedValueOnce(
        streamRow({
          depositedAmount: deposited.toString(),
          withdrawnAmount: deposited.toString(),
          ratePerSecond: '1000000',
          isActive: true,
        }),
      );

    const result = await applyMockAction('withdraw', RECIPIENT, { streamId: '900001' });

    expect(result.amount).toBe('86400000000');
    const eventTypes = mockPrismaObj.streamEvent.upsert.mock.calls.map(
      (call) => (call[0] as { create: { eventType: string } }).create.eventType,
    );
    expect(eventTypes).toContain('WITHDRAWN');
    expect(eventTypes).toContain('COMPLETED');
    expect(broadcastToStream).toHaveBeenCalledWith(
      '900001',
      'stream.withdrawn',
      expect.objectContaining({ mock: true }),
    );
  });

  it('rejects a withdraw when nothing is claimable', async () => {
    mockPrismaObj.stream.findUnique.mockResolvedValue(
      streamRow({ lastUpdateTime: BigInt(Math.floor(Date.now() / 1000)) }),
    );

    await expect(
      applyMockAction('withdraw', RECIPIENT, { streamId: '900001' }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('cancel', () => {
  it('deactivates the stream and records CANCELLED', async () => {
    mockPrismaObj.stream.findUnique.mockResolvedValue(streamRow());

    await cancel(900_001n, SENDER);

    expect(mockPrismaObj.stream.update).toHaveBeenCalledWith({
      where: { streamId: 900_001n },
      data: { isActive: false, isPaused: false, pausedAt: null },
    });
    expect(mockPrismaObj.streamEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ eventType: 'CANCELLED' }),
      }),
    );
  });

  it('cannot be applied twice', async () => {
    mockPrismaObj.stream.findUnique.mockResolvedValue(streamRow({ isActive: false }));

    await expect(cancel(900_001n, SENDER)).rejects.toMatchObject({ status: 409 });
  });
});

describe('applyMockAction', () => {
  it('creates a stream with a derived rate and an end time', async () => {
    mockPrismaObj.stream.aggregate.mockResolvedValue({ _max: { streamId: 900_020n } });
    mockPrismaObj.stream.create.mockResolvedValue(streamRow({ streamId: 900_021n }));

    const result = await applyMockAction('create_stream', SENDER, {
      recipient: RECIPIENT,
      tokenAddress: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      amount: '1000000000',
      duration: 1_000,
    });

    expect(result.streamId).toBe('900021');
    const created = mockPrismaObj.stream.create.mock.calls[0]?.[0] as {
      data: { ratePerSecond: string; endTime: bigint; startTime: bigint };
    };
    expect(created.data.ratePerSecond).toBe('1000000');
    expect(created.data.endTime).toBe(created.data.startTime + 1_000n);
  });

  it('rejects a rate that rounds to zero', async () => {
    await expect(
      applyMockAction('create_stream', SENDER, {
        recipient: RECIPIENT,
        tokenAddress: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
        amount: '10',
        duration: 1_000_000,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(mockPrismaObj.stream.create).not.toHaveBeenCalled();
  });

  it('rejects a malformed stream id', async () => {
    await expect(
      applyMockAction('pause_stream', SENDER, { streamId: 'not-a-number' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects an unknown action', async () => {
    await expect(
      applyMockAction('selfdestruct' as 'withdraw', SENDER, {}),
    ).rejects.toMatchObject({ status: 400 });
  });
});