import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  redisGet: vi.fn(),
  redisSet: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { tokenRegistry: { findUnique: mocks.findUnique, upsert: mocks.upsert } },
}));

vi.mock('../src/lib/redis.js', () => ({
  getPublisher: () => ({ get: mocks.redisGet, set: mocks.redisSet }),
}));

vi.mock('../src/lib/rpc-pool.js', () => ({
  rpcPool: { execute: mocks.execute },
}));

vi.mock('@stellar/stellar-sdk', () => ({
  Account: class { publicKey = 'GTEST'; constructor(_key: string, _sequence: string) {} },
  Asset: { native: () => ({ contractId: () => 'NATIVE' }) },
  Contract: class { constructor(_address: string) {} call(method: string) { return { method }; } },
  Keypair: { random: () => ({ publicKey: () => 'GTEST' }) },
  Networks: { PUBLIC: 'PUBLIC', TESTNET: 'TESTNET' },
  StrKey: { isValidContract: () => true },
  TransactionBuilder: class {
    method = '';
    constructor(_account: unknown, _options: unknown) {}
    addOperation(operation: { method: string }) { this.method = operation.method; return this; }
    setTimeout() { return this; }
    build() { return { method: this.method }; }
  },
  rpc: { Api: { isSimulationError: () => false } },
  scValToNative: (value: { value: unknown }) => value.value,
}));

import { getTokenMetadata } from '../src/services/token-registry.service.js';

const address = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const cached = {
  id: 'registry-1', contractAddress: address, symbol: 'TST', name: 'Test Token', decimals: 7,
  iconUrl: null, issuerAddress: null, isVerified: false, createdAt: new Date(0), updatedAt: new Date(0),
};

describe('getTokenMetadata cache and fallback paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.STELLAR_HORIZON_URL;
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue(cached);
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSet.mockResolvedValue('OK');
    mocks.execute.mockImplementation(async (_label, callback) => callback({
      simulateTransaction: async (tx: { method: string }) => ({ result: { retval: { value: tx.method === 'symbol' ? 'TST' : tx.method === 'decimals' ? 7 : 'Test Token' } } }),
    }));
  });

  it('uses Redis metadata only as a fallback when PostgreSQL is unavailable', async () => {
    mocks.findUnique.mockRejectedValue(new Error('database unavailable'));
    mocks.redisGet.mockResolvedValue(JSON.stringify(cached));

    await expect(getTokenMetadata(address)).resolves.toEqual(cached);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('treats corrupt Redis JSON as a cache miss and reports database unavailability', async () => {
    mocks.findUnique.mockRejectedValue(new Error('database unavailable'));
    mocks.redisGet.mockResolvedValue('{bad json');

    await expect(getTokenMetadata(address)).rejects.toMatchObject({ statusCode: 503 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('treats an unavailable Redis instance as a miss during database failure', async () => {
    mocks.findUnique.mockRejectedValue(new Error('database unavailable'));
    mocks.redisGet.mockRejectedValue(new Error('redis unavailable'));

    await expect(getTokenMetadata(address)).rejects.toMatchObject({ statusCode: 503 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('returns PostgreSQL cache hits without invoking RPC', async () => {
    mocks.findUnique.mockResolvedValue(cached);
    mocks.redisSet.mockRejectedValue(new Error('redis write failed'));

    await expect(getTokenMetadata(address)).resolves.toEqual(cached);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.redisSet).toHaveBeenCalledOnce();
  });

  it('resolves a cold lookup and succeeds even when writing Redis fails', async () => {
    mocks.redisSet.mockRejectedValue(new Error('redis write failed'));

    await expect(getTokenMetadata(address)).resolves.toEqual(cached);
    expect(mocks.execute).toHaveBeenCalledTimes(3);
    expect(mocks.upsert).toHaveBeenCalledOnce();
    expect(mocks.redisSet).toHaveBeenCalledOnce();
  });
});
