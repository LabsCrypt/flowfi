import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '../src/lib/api-error.js';
import type { TokenMetadata } from '../src/services/token-registry.service.js';

const mockPrisma = vi.hoisted(() => ({
  tokenRegistry: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
  },
}));

const mockRedis = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

const mockGetPublisher = vi.hoisted(() => vi.fn(() => mockRedis));

const mockRpcPool = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: mockPrisma,
}));

vi.mock('../src/lib/redis.js', () => ({
  getPublisher: mockGetPublisher,
}));

vi.mock('../src/lib/rpc-pool.js', () => ({
  rpcPool: mockRpcPool,
}));

vi.mock('../src/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  getTokenMetadata,
  listVerifiedTokens,
} from '../src/services/token-registry.service.js';

const VALID_ADDRESS = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const SAMPLE_METADATA: TokenMetadata = {
  id: 'token-uuid-1',
  contractAddress: VALID_ADDRESS,
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 7,
  iconUrl: 'https://example.com/usdc.png',
  issuerAddress: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  isVerified: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('token-registry.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPublisher.mockReturnValue(mockRedis as any);
    mockRedis.get.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue('OK');
  });

  describe('contract address validation', () => {
    it('throws 400 ApiError for invalid Stellar contract address', async () => {
      await expect(getTokenMetadata('invalid-contract-address')).rejects.toThrow(ApiError);
      try {
        await getTokenMetadata('invalid-contract-address');
      } catch (err: any) {
        expect(err.statusCode).toBe(400);
        expect(err.code).toBe('invalid_token_address');
      }
    });
  });

  describe('database cache hit path', () => {
    it('returns database record and avoids RPC calls', async () => {
      mockPrisma.tokenRegistry.findUnique.mockResolvedValue(SAMPLE_METADATA);

      const result = await getTokenMetadata(VALID_ADDRESS);

      expect(result).toEqual(SAMPLE_METADATA);
      expect(mockPrisma.tokenRegistry.findUnique).toHaveBeenCalledWith({
        where: { contractAddress: VALID_ADDRESS },
      });
      // Assert DB cache hits avoid RPC completely
      expect(mockRpcPool.execute).not.toHaveBeenCalled();
      // Asserts background cache population in Redis
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringContaining(VALID_ADDRESS),
        JSON.stringify(SAMPLE_METADATA),
        'EX',
        86400,
      );
    });

    it('asserts Redis write failures do not turn successful metadata lookup into an error', async () => {
      mockPrisma.tokenRegistry.findUnique.mockResolvedValue(SAMPLE_METADATA);
      // Redis set fails / rejects
      mockRedis.set.mockRejectedValue(new Error('Redis connection lost'));

      const result = await getTokenMetadata(VALID_ADDRESS);

      // Successfully returns database record despite Redis set rejection
      expect(result).toEqual(SAMPLE_METADATA);
      expect(mockRpcPool.execute).not.toHaveBeenCalled();
    });
  });

  describe('database failure & Redis fallback paths', () => {
    it('returns cached metadata from Redis when database is down (Redis hit)', async () => {
      mockPrisma.tokenRegistry.findUnique.mockRejectedValue(
        new Error('PostgreSQL connection refused'),
      );
      mockRedis.get.mockResolvedValue(JSON.stringify(SAMPLE_METADATA));

      const result = await getTokenMetadata(VALID_ADDRESS);

      expect(result).toEqual(JSON.parse(JSON.stringify(SAMPLE_METADATA)));
      expect(mockRedis.get).toHaveBeenCalledWith(
        expect.stringContaining(VALID_ADDRESS),
      );
      // Avoids RPC
      expect(mockRpcPool.execute).not.toHaveBeenCalled();
    });

    it('throws 503 when DB is down and Redis returns invalid JSON', async () => {
      mockPrisma.tokenRegistry.findUnique.mockRejectedValue(
        new Error('PostgreSQL connection refused'),
      );
      mockRedis.get.mockResolvedValue('invalid-json{{{');

      await expect(getTokenMetadata(VALID_ADDRESS)).rejects.toMatchObject({
        statusCode: 503,
        code: 'token_registry_unavailable',
      });
      expect(mockRpcPool.execute).not.toHaveBeenCalled();
    });

    it('throws 503 when DB is down and Redis client is unavailable (null publisher)', async () => {
      mockPrisma.tokenRegistry.findUnique.mockRejectedValue(
        new Error('PostgreSQL connection refused'),
      );
      mockGetPublisher.mockReturnValue(null as any);

      await expect(getTokenMetadata(VALID_ADDRESS)).rejects.toMatchObject({
        statusCode: 503,
        code: 'token_registry_unavailable',
      });
      expect(mockRpcPool.execute).not.toHaveBeenCalled();
    });

    it('throws 503 when DB is down and Redis get operation fails/rejects', async () => {
      mockPrisma.tokenRegistry.findUnique.mockRejectedValue(
        new Error('PostgreSQL connection refused'),
      );
      mockRedis.get.mockRejectedValue(new Error('Redis timeout'));

      await expect(getTokenMetadata(VALID_ADDRESS)).rejects.toMatchObject({
        statusCode: 503,
        code: 'token_registry_unavailable',
      });
      expect(mockRpcPool.execute).not.toHaveBeenCalled();
    });
  });

  describe('cold lookup path (cache miss)', () => {
    it('fetches metadata via RPC, upserts in DB, caches in Redis, and returns metadata', async () => {
      mockPrisma.tokenRegistry.findUnique.mockResolvedValue(null);
      // Simulate RPC calls for symbol, decimals, name
      mockRpcPool.execute.mockImplementation(async (label: string, _callback: any) => {
        if (label.includes('symbol')) return 'FLOW';
        if (label.includes('decimals')) return 7;
        if (label.includes('name')) return 'FlowFi Token';
        return null;
      });

      const upsertedMetadata: TokenMetadata = {
        id: 'token-uuid-2',
        contractAddress: VALID_ADDRESS,
        symbol: 'FLOW',
        name: 'FlowFi Token',
        decimals: 7,
        iconUrl: null,
        issuerAddress: null,
        isVerified: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      };
      mockPrisma.tokenRegistry.upsert.mockResolvedValue(upsertedMetadata);

      const result = await getTokenMetadata(VALID_ADDRESS);

      expect(result).toEqual(upsertedMetadata);
      expect(mockRpcPool.execute).toHaveBeenCalled();
      expect(mockPrisma.tokenRegistry.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { contractAddress: VALID_ADDRESS },
          create: expect.objectContaining({
            contractAddress: VALID_ADDRESS,
            symbol: 'FLOW',
            name: 'FlowFi Token',
            decimals: 7,
          }),
        }),
      );
      expect(mockRedis.set).toHaveBeenCalledWith(
        expect.stringContaining(VALID_ADDRESS),
        JSON.stringify(upsertedMetadata),
        'EX',
        86400,
      );
    });

    it('asserts Redis write failure on cold lookup does not prevent returning resolved metadata', async () => {
      mockPrisma.tokenRegistry.findUnique.mockResolvedValue(null);
      mockRpcPool.execute.mockImplementation(async (label: string) => {
        if (label.includes('symbol')) return 'FLOW';
        if (label.includes('decimals')) return 7;
        if (label.includes('name')) return 'FlowFi Token';
        return null;
      });

      const upsertedMetadata: TokenMetadata = {
        id: 'token-uuid-3',
        contractAddress: VALID_ADDRESS,
        symbol: 'FLOW',
        name: 'FlowFi Token',
        decimals: 7,
        iconUrl: null,
        issuerAddress: null,
        isVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockPrisma.tokenRegistry.upsert.mockResolvedValue(upsertedMetadata);
      mockRedis.set.mockRejectedValue(new Error('Redis write failed'));

      const result = await getTokenMetadata(VALID_ADDRESS);

      expect(result).toEqual(upsertedMetadata);
    });

    it('throws 502 ApiError when RPC resolution fails', async () => {
      mockPrisma.tokenRegistry.findUnique.mockResolvedValue(null);
      mockRpcPool.execute.mockRejectedValue(new Error('RPC node timeout'));

      await expect(getTokenMetadata(VALID_ADDRESS)).rejects.toMatchObject({
        statusCode: 502,
        code: 'token_resolution_failed',
      });
    });
  });

  describe('listVerifiedTokens', () => {
    it('returns verified tokens ordered by symbol ascending', async () => {
      const verifiedList = [SAMPLE_METADATA];
      mockPrisma.tokenRegistry.findMany.mockResolvedValue(verifiedList);

      const result = await listVerifiedTokens();

      expect(result).toEqual(verifiedList);
      expect(mockPrisma.tokenRegistry.findMany).toHaveBeenCalledWith({
        where: { isVerified: true },
        orderBy: { symbol: 'asc' },
      });
    });
  });
});
