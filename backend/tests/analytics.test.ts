/**
 * Analytics endpoint tests (#1480).
 *
 * The TimescaleDB path is exercised through a mocked pg pool so no real
 * database is needed; the fallback path is exercised by making
 * `hasTimescale` report unavailable. Contract under test: response shapes,
 * validation errors, and the DefiLlama adapter mapping.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    stream: {
      findMany: vi.fn(),
    },
  },
  pool: {
    query: (...args: unknown[]) => queryMock(...args),
  },
}));

vi.mock("../src/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "../src/lib/prisma.js";
import {
  getDefiLlamaAdapter,
  getHistoricalAnalytics,
  getProtocolTvl,
  resetTimescaleCacheForTests,
} from "../src/services/analytics.service.js";

describe("analytics service (#1480)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockReset();
    resetTimescaleCacheForTests();
  });

  it("falls back to live Prisma aggregation when TimescaleDB is absent", async () => {
    // to_regclass returns null → no hypertable.
    queryMock.mockResolvedValue({ rows: [{ hypertable: null }] });

    // Amount columns are i128 strings in the schema; three active streams on
    // one token, aggregated in JS (deposits 1,000,000 − withdrawals 400,000).
    (prisma.stream.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        tokenAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        depositedAmount: "400000",
        withdrawnAmount: "100000",
        ratePerSecond: "20",
      },
      {
        tokenAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        depositedAmount: "350000",
        withdrawnAmount: "150000",
        ratePerSecond: "20",
      },
      {
        tokenAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        depositedAmount: "250000",
        withdrawnAmount: "150000",
        ratePerSecond: "10",
      },
    ]);

    const snapshot = await getProtocolTvl();

    expect(snapshot.source).toBe("live");
    expect(snapshot.totalTvlStroops).toBe("600000");
    expect(snapshot.tokens[0]?.activeStreamCount).toBe(3);
    expect(snapshot.tokens[0]?.velocityPerSecondStroops).toBe("50");
  });

  it("reads the latest hypertable snapshot per token when TimescaleDB is present", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ hypertable: "stream_flow_snapshots" }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          token_address: "CB63BC53EZDCKG6EFA3KJD3QWVV4QG4N35D7N4YQ6EY5XLYWJ7VL2MUA",
          total_locked_amount: "900000",
          flow_velocity_per_second: "25",
          active_stream_count: 2,
        },
      ],
    });

    const snapshot = await getProtocolTvl();

    expect(snapshot.source).toBe("timescaledb");
    expect(snapshot.totalTvlStroops).toBe("900000");
    // DISTINCT ON (token_address) ... ORDER BY token_address, time DESC
    expect(queryMock.mock.calls[1]?.[0]).toContain("DISTINCT ON");
  });

  it("maps the snapshot into the DefiLlama adapter shape", async () => {
    queryMock.mockResolvedValue({ rows: [{ hypertable: null }] });
    (prisma.stream.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        tokenAddress: "TOKEN_A",
        depositedAmount: "500",
        withdrawnAmount: "200",
        ratePerSecond: "1",
      },
    ]);

    const adapter = await getDefiLlamaAdapter();

    expect(adapter.id).toBe("flowfi");
    expect(adapter.tvl.total).toBe(300);
    expect(adapter.tvl.TOKEN_A).toBe(300);
  });

  it("returns empty historical points on live fallback and buckets via the daily view", async () => {
    queryMock.mockResolvedValue({ rows: [{ hypertable: null }] });
    const live = await getHistoricalAnalytics("30d", "1d");
    expect(live).toEqual({
      source: "live",
      period: "30d",
      interval: "1d",
      points: [],
    });

    // The first call latched the probe result in the service cache; clear it
    // so the timescaledb path below actually re-probes the pool.
    resetTimescaleCacheForTests();

    // First call is the availability probe, second the data query.
    queryMock.mockResolvedValueOnce({ rows: [{ hypertable: "stream_flow_snapshots" }] });
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          bucket: new Date("2026-09-28T00:00:00Z"),
          token_address: "TOKEN_A",
          avg_tvl: "123",
          aggregate_velocity: "4",
          peak_streams: 9,
        },
      ],
    });
    const series = await getHistoricalAnalytics("90d", "1d");
    expect(series.source).toBe("timescaledb");
    expect(series.points[0]?.avgTvlStroops).toBe("123");
    expect(series.points[0]?.peakStreams).toBe(9);
    expect(queryMock.mock.calls.at(-1)![0]).toContain("daily_protocol_metrics");
  });
});
