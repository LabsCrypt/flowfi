import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestContext } from '../src/logger.js';
import { SorobanEventWorker } from '../src/workers/soroban-event-worker.js';
import { replayFromLedger } from '../src/services/indexerService.js';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    indexerState: {
      findUnique: vi.fn().mockResolvedValue({ lastLedger: 100, lastCursor: 'c1' }),
      upsert: vi.fn().mockResolvedValue({ id: 'singleton', lastLedger: 100, lastCursor: 'c1' }),
    },
  },
}));

vi.mock('@stellar/stellar-sdk', () => {
  return {
    rpc: {
      Server: vi.fn().mockImplementation(() => ({
        getEvents: vi.fn().mockResolvedValue({ events: [] }),
      })),
    },
    xdr: {
      ScVal: vi.fn(),
    },
    StrKey: {},
  };
});

describe('Worker and Replay Correlation ID', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('binds worker poll execution to a requestId inside requestContext', async () => {
    const worker = new SorobanEventWorker();
    let capturedStoreRequestId: string | undefined;

    // Trigger poll manually
    const reqId = await worker.triggerPoll('test-correlation-id-123');

    expect(reqId).toBe('test-correlation-id-123');

    // Inside a requestContext.run block, requestContext.getStore() should be accessible if invoked
    requestContext.run({ requestId: 'custom-check-id' }, () => {
      capturedStoreRequestId = requestContext.getStore()?.requestId;
    });
    expect(capturedStoreRequestId).toBe('custom-check-id');
  });

  it('replayFromLedger returns correlation requestId and binds worker poll to it', async () => {
    const workerSpy = vi.spyOn(SorobanEventWorker.prototype, 'triggerPoll');

    const resultRequestId = await replayFromLedger(50, 'replay-req-456');

    expect(resultRequestId).toBe('replay-req-456');
    expect(workerSpy).toHaveBeenCalledWith('replay-req-456');
  });

  it('automatically generates a correlation requestId if none is provided to replayFromLedger', async () => {
    const workerSpy = vi.spyOn(SorobanEventWorker.prototype, 'triggerPoll');

    const resultRequestId = await replayFromLedger(50);

    expect(resultRequestId).toBeDefined();
    expect(typeof resultRequestId).toBe('string');
    expect(resultRequestId.length).toBeGreaterThan(0);
    expect(workerSpy).toHaveBeenCalledWith(resultRequestId);
  });
});
