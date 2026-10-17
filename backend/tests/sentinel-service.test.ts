/**
 * Sentinel anomaly detection & high-velocity drain monitoring (Issue #1469).
 *
 * The suite exercises the sliding-window velocity trackers, every heuristic
 * rule and severity band, the alert fan-out adapter, and an end-to-end
 * simulated drain attack.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  requestContext: {},
}));

import {
  SENTINEL_RULES,
  SentinelService,
  getSentinelConfig,
  type SentinelConfig,
  type WithdrawalAnomalyInput,
} from '../src/services/sentinel.service.js';
import {
  RedisSlidingWindowTracker,
  InMemorySlidingWindowTracker,
} from '../src/lib/redis.js';

const BASE_CONFIG: SentinelConfig = {
  enabled: true,
  velocityWindowMs: 60_000,
  baselineWindowMs: 24 * 60 * 60 * 1_000,
  velocitySpikeMultiplier: 4,
  velocityMinEvents: 5,
  multiStreamMaxStreams: 20,
  multiStreamWindowLedgers: 3,
  highValueThresholdUsd: 100_000,
  balanceDrainPct: 80,
  creationSpikeWindowMs: 5 * 60 * 1_000,
  creationSpikeThreshold: 25,
  zeroRunwayMaxSeconds: 60,
  zeroRunwayWindowMs: 5 * 60 * 1_000,
  zeroRunwayFloodThreshold: 50,
  alertCooldownMs: 60_000,
  retentionMs: 24 * 60 * 60 * 1_000,
  threatWindowMs: 15 * 60 * 1_000,
  proposalSecret: 'test-sentinel-secret',
};

const START = 1_700_000_000_000;

function makeHarness(
  overrides: Partial<SentinelConfig> = {},
  fetchImpl?: typeof fetch,
) {
  let clock = START;
  const tracker = new InMemorySlidingWindowTracker();
  const service = new SentinelService(
    { ...BASE_CONFIG, ...overrides },
    { tracker, now: () => clock, ...(fetchImpl ? { fetchImpl } : {}) },
  );
  return {
    service,
    tracker,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    set: (ms: number) => {
      clock = ms;
    },
  };
}

function withdrawal(
  overrides: Partial<WithdrawalAnomalyInput> = {},
): WithdrawalAnomalyInput {
  return {
    address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    token: 'CUSDC',
    amount: '10',
    streamId: '1',
    ledger: 100,
    txHash: `tx-${Math.random().toString(36).slice(2)}`,
    now: START,
    ...overrides,
  };
}

describe('SentinelService — velocity tracking & severity bands', () => {
  it('stays quiet for a steady withdrawal cadence', async () => {
    const { service, now, advance } = makeHarness();
    const results: unknown[] = [];
    for (let i = 0; i < 10; i += 1) {
      results.push(
        await service.recordWithdrawal(
          withdrawal({
            amount: '50',
            streamId: String(i),
            txHash: `steady-${i}`,
            now: now(),
          }),
        ),
      );
      // One withdrawal every ~30s: at most a couple land inside any 60s
      // window, so the per-minute volume stays flat against its baseline.
      advance(30_000);
    }
    expect(results.flat()).toHaveLength(0);
  });

  it('categorises a 5x volume spike as MEDIUM', async () => {
    const { service, now } = makeHarness();
    // Seed the 24h baseline: one 100-unit withdrawal 12h ago.
    await service.recordWithdrawal(
      withdrawal({ amount: '100', txHash: 'baseline', now: now() - 12 * 60 * 60 * 1_000 }),
    );

    let incidents: Awaited<ReturnType<typeof service.recordWithdrawal>> = [];
    for (let i = 0; i < 5; i += 1) {
      incidents = await service.recordWithdrawal(
        withdrawal({
          amount: '0.07',
          streamId: `spike-${i}`,
          txHash: `spike-${i}`,
          now: now(),
        }),
      );
    }

    const velocity = incidents.find((i) => i.ruleId === SENTINEL_RULES.VELOCITY_SPIKE);
    expect(velocity).toBeDefined();
    expect(velocity?.severity).toBe('MEDIUM');
  });

  it('categorises a 7x volume spike as HIGH', async () => {
    const { service, now } = makeHarness();
    await service.recordWithdrawal(
      withdrawal({ amount: '100', txHash: 'baseline', now: now() - 12 * 60 * 60 * 1_000 }),
    );

    let incidents: Awaited<ReturnType<typeof service.recordWithdrawal>> = [];
    for (let i = 0; i < 5; i += 1) {
      incidents = await service.recordWithdrawal(
        withdrawal({ amount: '0.1', streamId: `spike-${i}`, txHash: `spike-${i}`, now: now() }),
      );
    }

    const velocity = incidents.find((i) => i.ruleId === SENTINEL_RULES.VELOCITY_SPIKE);
    expect(velocity?.severity).toBe('HIGH');
  });

  it('categorises an extreme volume spike as CRITICAL and signs a pause proposal', async () => {
    const { service, now } = makeHarness();
    await service.recordWithdrawal(
      withdrawal({ amount: '100', txHash: 'baseline', now: now() - 12 * 60 * 60 * 1_000 }),
    );

    let incidents: Awaited<ReturnType<typeof service.recordWithdrawal>> = [];
    for (let i = 0; i < 5; i += 1) {
      incidents = await service.recordWithdrawal(
        withdrawal({ amount: '0.5', streamId: `spike-${i}`, txHash: `spike-${i}`, now: now() }),
      );
    }

    const velocity = incidents.find((i) => i.ruleId === SENTINEL_RULES.VELOCITY_SPIKE);
    expect(velocity?.severity).toBe('CRITICAL');
    expect(velocity?.circuitBreaker).not.toBeNull();
    expect(velocity?.circuitBreaker?.action).toBe('set_emergency_pause');
    expect(velocity?.circuitBreaker?.value).toBe(true);
    expect(velocity?.circuitBreaker?.payloadHash).toHaveLength(64);
    expect(velocity?.circuitBreaker?.signature).toHaveLength(64);
    expect(velocity?.circuitBreaker?.algorithm).toBe('hmac-sha256');
  });

  it('isolates velocity per address', async () => {
    const { service, now } = makeHarness();
    const victim = 'GVICTIMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await service.recordWithdrawal(
      withdrawal({ address: victim, amount: '100', txHash: 'baseline', now: now() - 12 * 60 * 60 * 1_000 }),
    );

    // A different wallet's burst must not be attributed to the victim.
    let incidents: Awaited<ReturnType<typeof service.recordWithdrawal>> = [];
    for (let i = 0; i < 5; i += 1) {
      incidents = await service.recordWithdrawal(
        withdrawal({
          address: 'GOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          amount: '10',
          streamId: `x-${i}`,
          txHash: `x-${i}`,
          now: now(),
        }),
      );
    }
    expect(incidents.find((i) => i.ruleId === SENTINEL_RULES.VELOCITY_SPIKE)?.address).not.toBe(victim);
  });
});

describe('SentinelService — drain heuristics', () => {
  it('flags a rapid multi-stream drain once the distinct-stream bar is crossed', async () => {
    const { service, now } = makeHarness({
      multiStreamMaxStreams: 3,
      velocityMinEvents: 100, // disable the velocity rule for this case
    });

    let incidents: Awaited<ReturnType<typeof service.recordWithdrawal>> = [];
    for (let i = 0; i < 4; i += 1) {
      incidents = await service.recordWithdrawal(
        withdrawal({ streamId: `s-${i}`, txHash: `drain-${i}`, now: now() }),
      );
    }

    const drain = incidents.find((i) => i.ruleId === SENTINEL_RULES.MULTI_STREAM_DRAIN);
    expect(drain?.severity).toBe('HIGH');
    expect(drain?.evidence.distinctStreams).toBe(4);
  });

  it('escalates a very wide multi-stream drain to CRITICAL', async () => {
    const { service, now } = makeHarness({
      multiStreamMaxStreams: 2,
      velocityMinEvents: 100,
    });

    let incidents: Awaited<ReturnType<typeof service.recordWithdrawal>> = [];
    for (let i = 0; i < 6; i += 1) {
      incidents = await service.recordWithdrawal(
        withdrawal({ streamId: `s-${i}`, txHash: `wide-${i}`, now: now() }),
      );
    }
    expect(
      incidents.find((i) => i.ruleId === SENTINEL_RULES.MULTI_STREAM_DRAIN)?.severity,
    ).toBe('CRITICAL');
  });

  it('flags a single withdrawal above the USD notional threshold', async () => {
    const { service } = makeHarness({ velocityMinEvents: 100 });
    const incidents = await service.recordWithdrawal(
      withdrawal({ amount: '1', amountUsd: 250_000, txHash: 'whale' }),
    );

    const drain = incidents.find((i) => i.ruleId === SENTINEL_RULES.HIGH_VALUE_DRAIN);
    expect(drain).toBeDefined();
    expect(drain?.severity).toBe('CRITICAL'); // >= 2x the 100k threshold
  });

  it('flags a withdrawal draining >80% of the stream balance without a price feed', async () => {
    const { service } = makeHarness({ velocityMinEvents: 100 });
    const incidents = await service.recordWithdrawal(
      withdrawal({
        amount: '90',
        streamDeposited: '100',
        txHash: 'balance-drain',
      }),
    );

    const drain = incidents.find((i) => i.ruleId === SENTINEL_RULES.HIGH_VALUE_DRAIN);
    expect(drain).toBeDefined();
    expect(drain?.severity).toBe('HIGH');
    expect(drain?.evidence.drainedPct).toBeCloseTo(90);
  });

  it('does not flag a routine partial withdrawal', async () => {
    const { service } = makeHarness({ velocityMinEvents: 100 });
    const incidents = await service.recordWithdrawal(
      withdrawal({ amount: '10', streamDeposited: '1000', txHash: 'routine' }),
    );
    expect(incidents).toHaveLength(0);
  });
});

describe('SentinelService — stream creation heuristics', () => {
  it('flags a zero-runway stream flood as CRITICAL', async () => {
    const { service, now } = makeHarness({
      zeroRunwayFloodThreshold: 3,
      creationSpikeThreshold: 1000,
    });

    let incidents: Awaited<ReturnType<typeof service.recordStreamCreation>> = [];
    for (let i = 0; i < 4; i += 1) {
      incidents = await service.recordStreamCreation({
        sender: 'GSENDERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        token: 'CUSDC',
        streamId: String(i),
        runwaySeconds: 5,
        ledger: 200 + i,
        now: now(),
      });
    }

    const flood = incidents.find((i) => i.ruleId === SENTINEL_RULES.ZERO_RUNWAY_FLOOD);
    expect(flood?.severity).toBe('CRITICAL');
    expect(flood?.circuitBreaker).not.toBeNull();
  });

  it('flags a per-token stream creation spike', async () => {
    const { service, now } = makeHarness({ creationSpikeThreshold: 2 });

    let incidents: Awaited<ReturnType<typeof service.recordStreamCreation>> = [];
    for (let i = 0; i < 3; i += 1) {
      incidents = await service.recordStreamCreation({
        sender: 'GSENDERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        token: 'CXLM',
        streamId: `k-${i}`,
        runwaySeconds: 86_400,
        ledger: 300 + i,
        now: now(),
      });
    }

    const spike = incidents.find((i) => i.ruleId === SENTINEL_RULES.STREAM_CREATION_SPIKE);
    expect(spike).toBeDefined();
    expect(spike?.severity).toBe('MEDIUM');
  });
});

describe('SentinelService — alerting', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ status: 204, ok: true });
  });

  it('dispatches a rich incident payload to the configured channels', async () => {
    const { service } = makeHarness(
      {
        discordWebhookUrl: 'https://discord.test/webhook',
        slackWebhookUrl: 'https://hooks.slack.test/abc',
        pagerDutyRoutingKey: 'pd-routing-key',
        velocityMinEvents: 100,
      },
      fetchMock as unknown as typeof fetch,
    );

    const incidents = await service.recordWithdrawal(
      withdrawal({ amount: '1', amountUsd: 500_000, txHash: 'alert-me' }),
    );
    const drain = incidents.find((i) => i.ruleId === SENTINEL_RULES.HIGH_VALUE_DRAIN);
    expect(drain).toBeDefined();

    const urls = fetchMock.mock.calls.map((call) => call[0]);
    expect(urls).toContain('https://discord.test/webhook');
    expect(urls).toContain('https://hooks.slack.test/abc');
    expect(urls).toContain('https://events.pagerduty.com/v2/enqueue');

    const discordBody = JSON.parse(
      String(fetchMock.mock.calls.find((c) => c[0] === 'https://discord.test/webhook')?.[1]?.body),
    );
    expect(discordBody.embeds[0].title).toContain('HIGH_VALUE_DRAIN');
    expect(discordBody.sentinel.severity).toBe('CRITICAL');

    const pdBody = JSON.parse(
      String(
        fetchMock.mock.calls.find((c) => c[0] === 'https://events.pagerduty.com/v2/enqueue')?.[1]
          ?.body,
      ),
    );
    expect(pdBody.routing_key).toBe('pd-routing-key');
    expect(pdBody.event_action).toBe('trigger');
    expect(pdBody.payload.severity).toBe('critical');
  });

  it('survives an unreachable alert endpoint', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const { service } = makeHarness(
      { slackWebhookUrl: 'https://hooks.slack.test/down', velocityMinEvents: 100 },
      failing as unknown as typeof fetch,
    );

    const incidents = await service.recordWithdrawal(
      withdrawal({ amount: '1', amountUsd: 500_000, txHash: 'resilient' }),
    );
    expect(incidents).toHaveLength(1);
    const deliveries = await service.dispatchAlert(incidents[0]!);
    expect(deliveries[0]).toMatchObject({ channel: 'slack', ok: false });
  });

  it('suppresses repeat alerts for the same rule + subject inside the cooldown', async () => {
    const { service, now } = makeHarness({
      velocityMinEvents: 100,
      alertCooldownMs: 300_000,
    });

    const first = await service.recordWithdrawal(
      withdrawal({ amount: '90', streamDeposited: '100', streamId: '42', txHash: 'first', now: now() }),
    );
    expect(first).toHaveLength(1);

    const second = await service.recordWithdrawal(
      withdrawal({ amount: '95', streamDeposited: '100', streamId: '42', txHash: 'second', now: now() }),
    );
    expect(second).toHaveLength(0);

    // After the cooldown the same subject can alert again.
    now();
    const later = await service.recordWithdrawal(
      withdrawal({
        amount: '96',
        streamDeposited: '100',
        streamId: '42',
        txHash: 'third',
        now: now() + 400_000,
      }),
    );
    expect(later).toHaveLength(1);
  });
});

describe('SentinelService — dashboard read APIs', () => {
  it('exposes a threat score and ranked flagged addresses', async () => {
    const { service } = makeHarness({ velocityMinEvents: 100 });
    await service.recordWithdrawal(
      withdrawal({ amount: '1', amountUsd: 500_000, txHash: 't1' }),
    );
    await service.recordWithdrawal(
      withdrawal({ amount: '1', amountUsd: 500_000, streamId: '2', txHash: 't2' }),
    );

    const summary = service.getThreatScore();
    expect(summary.score).toBeGreaterThan(0);
    expect(summary.level).not.toBe('NONE');
    expect(summary.bySeverity.CRITICAL).toBeGreaterThan(0);

    const flagged = service.getFlaggedAddresses();
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged[0]?.address).toBe('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(flagged[0]?.highestSeverity).toBe('CRITICAL');
  });

  it('filters alerts by severity and acknowledges incidents', async () => {
    const { service } = makeHarness({ velocityMinEvents: 100 });
    const incidents = await service.recordWithdrawal(
      withdrawal({ amount: '1', amountUsd: 500_000, txHash: 'ack' }),
    );

    expect(service.getAlerts({ severity: 'CRITICAL' })).toHaveLength(1);
    expect(service.getAlerts({ severity: 'LOW' })).toHaveLength(0);
    expect(service.getAlerts({ address: 'GNOPE' })).toHaveLength(0);

    expect(service.acknowledgeAlert(incidents[0]!.id)).toBe(true);
    expect(service.getAlerts()[0]?.acknowledged).toBe(true);
    expect(service.acknowledgeAlert('missing-id')).toBe(false);
  });

  it('clears retained state on reset', async () => {
    const { service } = makeHarness({ velocityMinEvents: 100 });
    await service.recordWithdrawal(
      withdrawal({ amount: '1', amountUsd: 500_000, txHash: 'reset' }),
    );
    expect(service.getAlerts()).toHaveLength(1);

    await service.reset();
    expect(service.getAlerts()).toHaveLength(0);
    expect(service.getThreatScore().score).toBe(0);
  });
});

describe('SentinelService — simulated drain attack', () => {
  it('raises velocity and multi-stream incidents during a coordinated drain', async () => {
    const { service, now } = makeHarness({
      multiStreamMaxStreams: 10,
      velocityMinEvents: 5,
    });
    const attacker = 'GATTACKERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    // Establish a low-volume 24h baseline for this wallet.
    await service.recordWithdrawal(
      withdrawal({ address: attacker, amount: '5', txHash: 'hist', now: now() - 12 * 60 * 60 * 1_000 }),
    );

    const raised: string[] = [];
    // 15 withdrawals across 15 distinct streams inside one minute.
    for (let i = 0; i < 15; i += 1) {
      const incidents = await service.recordWithdrawal(
        withdrawal({
          address: attacker,
          amount: '5000',
          streamId: `victim-${i}`,
          txHash: `attack-${i}`,
          ledger: 1000 + i,
          now: now() + i * 1_000,
        }),
      );
      raised.push(...incidents.map((incident) => incident.ruleId));
    }

    expect(raised).toContain(SENTINEL_RULES.VELOCITY_SPIKE);
    expect(raised).toContain(SENTINEL_RULES.MULTI_STREAM_DRAIN);

    // The attacker is the top flagged address and the dashboard agrees.
    expect(service.getFlaggedAddresses()[0]?.address).toBe(attacker);
    expect(service.getThreatScore().level).not.toBe('NONE');
  });
});

describe('SentinelService — config', () => {
  it('reads thresholds from the environment with sane defaults', () => {
    const original = { ...process.env };
    process.env.SENTINEL_ENABLED = 'false';
    process.env.SENTINEL_MULTI_STREAM_MAX = '7';
    delete process.env.SENTINEL_VELOCITY_SPIKE_MULTIPLIER;

    const config = getSentinelConfig();
    expect(config.enabled).toBe(false);
    expect(config.multiStreamMaxStreams).toBe(7);
    expect(config.velocitySpikeMultiplier).toBe(4);

    process.env = original;
  });

  it('is a no-op when disabled', async () => {
    const { service } = makeHarness({ enabled: false, velocityMinEvents: 1 });
    const incidents = await service.recordWithdrawal(
      withdrawal({ amount: '1', amountUsd: 999_999, txHash: 'disabled' }),
    );
    expect(incidents).toHaveLength(0);
  });
});

// ─── Redis-backed sliding-window tracker ────────────────────────────────────

/** Minimal in-memory stand-in for the ioredis sorted-set commands used. */
function createFakeRedis(): Redis {
  const zsets = new Map<string, Map<string, number>>();
  const get = (key: string) => {
    let set = zsets.get(key);
    if (!set) {
      set = new Map();
      zsets.set(key, set);
    }
    return set;
  };

  return {
    zadd: async (key: string, score: number | string, member: string) => {
      get(key).set(member, Number(score));
      return 1;
    },
    zremrangebyscore: async (key: string, _min: string | number, max: string | number) => {
      const set = get(key);
      const maxValue = max === '+inf' ? Number.POSITIVE_INFINITY : Number(max);
      let removed = 0;
      for (const [member, score] of [...set]) {
        if (score <= maxValue) {
          set.delete(member);
          removed += 1;
        }
      }
      return removed;
    },
    zrangebyscore: async (key: string, min: string | number, _max: string | number) => {
      const set = get(key);
      const minValue = typeof min === 'string' && min.startsWith('(') ? Number(min.slice(1)) : Number(min);
      const out: string[] = [];
      for (const [member, score] of [...set.entries()].sort((a, b) => a[1] - b[1])) {
        if (score >= minValue) out.push(member, String(score));
      }
      return out;
    },
    zcount: async (key: string, min: string | number) => {
      const minValue = typeof min === 'string' && min.startsWith('(') ? Number(min.slice(1)) : Number(min);
      return [...get(key).values()].filter((score) => score >= minValue).length;
    },
    pexpire: async () => 1,
    del: async (key: string) => {
      zsets.delete(key);
      return 1;
    },
  } as unknown as Redis;
}

describe('RedisSlidingWindowTracker', () => {
  it('counts events and sums weights inside the window via sorted sets', async () => {
    const tracker = new RedisSlidingWindowTracker(createFakeRedis());
    await tracker.add('k', 'a', 10, 1_000);
    await tracker.add('k', 'b', 20, 2_000);
    await tracker.add('k', 'c', 30, 3_000);

    const snapshot = await tracker.snapshot('k', 10_000, 4_000);
    expect(snapshot.count).toBe(3);
    expect(snapshot.sum).toBe(60);
    expect(snapshot.firstAt).toBe(1_000);
    expect(snapshot.lastAt).toBe(3_000);
  });

  it('ages samples out of the window and deduplicates by id', async () => {
    const tracker = new RedisSlidingWindowTracker(createFakeRedis());
    await tracker.add('k', 'old', 5, 1_000);
    await tracker.add('k', 'new', 5, 9_000);

    const snapshot = await tracker.snapshot('k', 5_000, 10_000);
    expect(snapshot.count).toBe(1);
    expect(snapshot.sum).toBe(5);

    // Re-adding the same id refreshes the timestamp instead of duplicating.
    await tracker.add('k', 'new', 5, 9_500);
    expect(await tracker.distinct('k', 5_000, 10_000)).toBe(1);
  });

  it('reports distinct ids for multi-stream tracking', async () => {
    const tracker = new RedisSlidingWindowTracker(createFakeRedis());
    await tracker.add('streams', 's1', 1, 1_000);
    await tracker.add('streams', 's1', 1, 1_100);
    await tracker.add('streams', 's2', 1, 1_200);
    expect(await tracker.distinct('streams', 10_000, 2_000)).toBe(2);

    await tracker.clear('streams');
    expect(await tracker.distinct('streams', 10_000, 2_000)).toBe(0);
  });
});

describe('InMemorySlidingWindowTracker', () => {
  it('supports the same add/snapshot/distinct contract', async () => {
    const tracker = new InMemorySlidingWindowTracker();
    await tracker.add('k', 'a', 2, 1_000);
    await tracker.add('k', 'b', 3, 2_000);

    expect(await tracker.snapshot('k', 5_000, 3_000)).toMatchObject({ count: 2, sum: 5 });
    expect(await tracker.distinct('k', 5_000, 3_000)).toBe(2);
    // The 1s sample has aged out of a 1.5s window measured at 3s.
    expect(await tracker.snapshot('k', 1_500, 3_000)).toMatchObject({ count: 1, sum: 3 });
  });
});
