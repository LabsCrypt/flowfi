import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sorobanIndexerService } from '../src/services/soroban-indexer.service.js';

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

// This service only reads/writes via a handful of prisma calls; mocking it
// out keeps these tests independent of whether the Prisma client has been
// generated (e.g. in a checkout without a `prisma generate` step).
vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    streamEvent: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    stream: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    user: {
      upsert: vi.fn(),
    },
  },
}));

describe('Soroban Indexer Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should start and stop the indexer', () => {
    sorobanIndexerService.start();
    sorobanIndexerService.stop();
  });
});

describe('Soroban Indexer Service - RPC resilience', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.STREAM_CONTRACT_ID;
    delete process.env.SOROBAN_RPC_TIMEOUT_MS;
    delete process.env.SOROBAN_RPC_MAX_RETRIES;
  });

  it('bounds a hung getEvents fetch with the configured RPC timeout instead of stalling the poll loop', async () => {
    process.env.STREAM_CONTRACT_ID = 'CCONTRACTIDEXAMPLE0000000000000000000000000000000000000';
    process.env.SOROBAN_RPC_TIMEOUT_MS = '1000';
    process.env.SOROBAN_RPC_MAX_RETRIES = '0';

    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})) // a hung endpoint that never responds
    );
    vi.useFakeTimers();

    const logger = (await import('../src/logger.js')).default;
    const { sorobanIndexerService: indexer } = await import('../src/services/soroban-indexer.service.js');

    indexer.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(logger.error).toHaveBeenCalledWith(
      'Soroban indexer poll failed',
      expect.objectContaining({ name: 'RpcTimeoutError' })
    );

    indexer.stop();
  });
});
