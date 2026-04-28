import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';

// Mock Prisma so tests don't require a real DB connection
vi.mock('../src/lib/prisma.js', () => ({
  default: {
    stream: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1n }]),
    $disconnect: vi.fn(),
  },
  prisma: {
    stream: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1n }]),
    $disconnect: vi.fn(),
  },
}));

import { prisma } from '../src/lib/prisma.js';

describe('POST /v1/streams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 201 when stream is created successfully', async () => {
    const mockStream = {
      id: 'uuid-123',
      streamId: 1,
      sender: 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA',
      recipient: 'GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD',
      tokenAddress: 'CBCD789EFG012HIJ345KLM678NOP901QRS234TUV567WXY890ZAB123CDE',
      ratePerSecond: '100',
      depositedAmount: '86400',
      withdrawnAmount: '0',
      startTime: 1700000000,
      lastUpdateTime: 1700000000,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    (prisma.stream.upsert as ReturnType<typeof vi.fn>).mockResolvedValue(mockStream);

    const validData = {
      streamId: '1',
      sender: 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA',
      recipient: 'GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD',
      tokenAddress: 'CBCD789EFG012HIJ345KLM678NOP901QRS234TUV567WXY890ZAB123CDE',
      ratePerSecond: '100',
      depositedAmount: '86400',
      startTime: '1700000000',
    };

    const response = await request(app)
      .post('/v1/streams')
      .send(validData)
      .set('Accept', 'application/json');

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      streamId: 1,
      sender: validData.sender,
      recipient: validData.recipient,
    });
  });

  it('should return 500 when stream creation fails (DB error)', async () => {
    (prisma.stream.upsert as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('DB connection failed')
    );

    const validData = {
      streamId: '2',
      sender: 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA',
      recipient: 'GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD',
      tokenAddress: 'CBCD789EFG012HIJ345KLM678NOP901QRS234TUV567WXY890ZAB123CDE',
      ratePerSecond: '100',
      depositedAmount: '86400',
      startTime: '1700000000',
    };

    const response = await request(app)
      .post('/v1/streams')
      .send(validData)
      .set('Accept', 'application/json');

    expect(response.status).toBe(500);
    expect(response.body).toHaveProperty('error');
  });

});

describe('GET /v1/streams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 200 with list of streams', async () => {
    (prisma.stream.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const response = await request(app)
      .get('/v1/streams')
      .set('Accept', 'application/json');

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });
});

describe('GET /v1/users/:address/summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all-zero summary for addresses with no streams', async () => {
    prisma.stream.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const address = 'GZERO000000000000000000000000000000000000000000000000000000';
    const response = await request(app).get(`/v1/users/${address}/summary`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      address,
      totalStreamsCreated: 0,
      totalStreamedOut: '0',
      totalStreamedIn: '0',
      currentClaimable: '0',
      activeOutgoingCount: 0,
      activeIncomingCount: 0,
    });
  });

  it('returns accurate outgoing/incoming aggregates and claimable sum', async () => {
    prisma.stream.findMany
      .mockResolvedValueOnce([
        { withdrawnAmount: '30', isActive: true },
        { withdrawnAmount: '20', isActive: false },
      ])
      .mockResolvedValueOnce([
        {
          streamId: 11,
          ratePerSecond: '10',
          depositedAmount: '1000',
          withdrawnAmount: '100',
          lastUpdateTime: 0,
          isActive: true,
          updatedAt: new Date(),
        },
        {
          streamId: 12,
          ratePerSecond: '1',
          depositedAmount: '200',
          withdrawnAmount: '50',
          lastUpdateTime: 0,
          isActive: false,
          updatedAt: new Date(),
        },
      ]);

    const address = 'GACCURATE00000000000000000000000000000000000000000000000000';
    const response = await request(app).get(`/v1/users/${address}/summary`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      address,
      totalStreamsCreated: 2,
      totalStreamedOut: '50',
      totalStreamedIn: '150',
      currentClaimable: '900',
      activeOutgoingCount: 1,
      activeIncomingCount: 1,
    });
  });

  it('caches summary results for repeated requests within TTL', async () => {
    prisma.stream.findMany
      .mockResolvedValueOnce([{ withdrawnAmount: '1', isActive: true }])
      .mockResolvedValueOnce([]);

    const address = 'GCACHE000000000000000000000000000000000000000000000000000000';

    const first = await request(app).get(`/v1/users/${address}/summary`);
    const second = await request(app).get(`/v1/users/${address}/summary`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(prisma.stream.findMany).toHaveBeenCalledTimes(2);
  });
});
