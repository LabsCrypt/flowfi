/**
 * Real-Time Stream Anomaly Detection & High-Velocity Drain Sentinel (Issue #1469)
 *
 * Decentralized payment streaming is exposed to private-key compromise, rogue
 * batch drains and fee diversion: by the time a human notices anomalous
 * activity in a log line, a compromised payroll wallet can have streamed out
 * millions. This service watches stream lifecycle events as they are indexed
 * and raises severity-graded incidents when their velocity or shape crosses
 * learned/heuristic thresholds.
 *
 * Design
 * ------
 * - **Velocity trackers** are sliding windows over Redis sorted sets (see
 *   `getSlidingWindowTracker` in `lib/redis.ts`), with a transparent in-memory
 *   fallback so detection still works on single-instance deployments.
 * - **Heuristics** are pure functions of the window aggregates, so they are
 *   cheap to run inline on the indexer hot path and trivially unit-testable.
 * - **Alerting** fans out through a unified adapter to Slack, Discord and
 *   PagerDuty. Every incident is retained in a bounded in-process history that
 *   the admin API exposes.
 * - **Circuit breaker** — CRITICAL incidents additionally produce an
 *   HMAC-signed `set_emergency_pause(true)` proposal so multisig signers can
 *   act without hand-authoring the payload during an incident.
 */

import crypto from 'crypto';
import logger from '../logger.js';
import {
  getSlidingWindowTracker,
  type SlidingWindowTracker,
  type SlidingWindowSnapshot,
} from '../lib/redis.js';
import {
  sentinelAlertsDispatchedTotal,
  sentinelIncidentsTotal,
  setSentinelThreatScore,
} from '../lib/metrics.js';

// ─── Severity ────────────────────────────────────────────────────────────────

export const SENTINEL_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type SentinelSeverity = (typeof SENTINEL_SEVERITIES)[number];

const SEVERITY_WEIGHT: Record<SentinelSeverity, number> = {
  LOW: 10,
  MEDIUM: 25,
  HIGH: 50,
  CRITICAL: 90,
};

function higherSeverity(
  a: SentinelSeverity,
  b: SentinelSeverity,
): SentinelSeverity {
  return SEVERITY_WEIGHT[a] >= SEVERITY_WEIGHT[b] ? a : b;
}

export function isSentinelSeverity(value: unknown): value is SentinelSeverity {
  return (
    typeof value === 'string' &&
    (SENTINEL_SEVERITIES as readonly string[]).includes(value)
  );
}

// ─── Rules ───────────────────────────────────────────────────────────────────

export const SENTINEL_RULES = {
  /** A wallet's withdrawal volume in one minute dwarfs its 24h baseline. */
  VELOCITY_SPIKE: 'VELOCITY_SPIKE',
  /** One address withdrawing across an unusual number of distinct streams. */
  MULTI_STREAM_DRAIN: 'MULTI_STREAM_DRAIN',
  /** A single withdrawal that is huge in absolute or relative terms. */
  HIGH_VALUE_DRAIN: 'HIGH_VALUE_DRAIN',
  /** The same as VELOCITY_SPIKE but scoped to one token across all wallets. */
  TOKEN_VELOCITY_SPIKE: 'TOKEN_VELOCITY_SPIKE',
  /** A flood of near-zero-runway streams, the classic dust-drain shape. */
  ZERO_RUNWAY_FLOOD: 'ZERO_RUNWAY_FLOOD',
  /** Abrupt burst of stream creations for a single token. */
  STREAM_CREATION_SPIKE: 'STREAM_CREATION_SPIKE',
} as const;

export type SentinelRuleId =
  (typeof SENTINEL_RULES)[keyof typeof SENTINEL_RULES];

// ─── Config ──────────────────────────────────────────────────────────────────

export interface SentinelConfig {
  enabled: boolean;
  /** Rolling window for per-minute velocity comparisons (default 60s). */
  velocityWindowMs: number;
  /** Baseline window a spike is measured against (default 24h). */
  baselineWindowMs: number;
  /**
   * A spike is declared when the current window is at least this many times
   * the baseline average. 4 == a 300% increase.
   */
  velocitySpikeMultiplier: number;
  /** Minimum withdrawals in the window before a velocity spike can fire. */
  velocityMinEvents: number;
  /** Distinct streams one address may drain inside the ledger window. */
  multiStreamMaxStreams: number;
  /** Ledgers the multi-stream drain window spans (default 3). */
  multiStreamWindowLedgers: number;
  /** Single-withdrawal notional (USD) that is always suspicious. */
  highValueThresholdUsd: number;
  /** Share of a stream's deposit a single withdrawal may consume (%). */
  balanceDrainPct: number;
  /** Stream creations per token inside `creationSpikeWindowMs`. */
  creationSpikeWindowMs: number;
  creationSpikeThreshold: number;
  /** Streams with a runway shorter than this count toward the flood. */
  zeroRunwayMaxSeconds: number;
  zeroRunwayWindowMs: number;
  zeroRunwayFloodThreshold: number;
  /** Suppress repeat alerts for the same rule+subject within this window. */
  alertCooldownMs: number;
  /** Incidents older than this are pruned from history. */
  retentionMs: number;
  /** Trailing window the aggregate threat score is computed over. */
  threatWindowMs: number;
  slackWebhookUrl?: string;
  discordWebhookUrl?: string;
  pagerDutyRoutingKey?: string;
  /** Secret used to HMAC-sign emergency pause proposals. */
  proposalSecret: string;
}

const LEDGER_MS = 5_000; // Stellar targets ~5s ledgers

function readNumberEnv(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

function readOptionalEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

export function getSentinelConfig(): SentinelConfig {
  const slackWebhookUrl = readOptionalEnv('SENTINEL_SLACK_WEBHOOK_URL');
  const discordWebhookUrl = readOptionalEnv('SENTINEL_DISCORD_WEBHOOK_URL');
  const pagerDutyRoutingKey = readOptionalEnv('SENTINEL_PAGERDUTY_ROUTING_KEY');

  return {
    enabled: readBooleanEnv('SENTINEL_ENABLED', true),
    velocityWindowMs: readNumberEnv('SENTINEL_VELOCITY_WINDOW_MS', 60_000),
    baselineWindowMs: readNumberEnv(
      'SENTINEL_BASELINE_WINDOW_MS',
      24 * 60 * 60 * 1000,
    ),
    velocitySpikeMultiplier: readNumberEnv(
      'SENTINEL_VELOCITY_SPIKE_MULTIPLIER',
      4,
    ),
    velocityMinEvents: readNumberEnv('SENTINEL_VELOCITY_MIN_EVENTS', 5),
    multiStreamMaxStreams: readNumberEnv('SENTINEL_MULTI_STREAM_MAX', 20),
    multiStreamWindowLedgers: readNumberEnv(
      'SENTINEL_MULTI_STREAM_WINDOW_LEDGERS',
      3,
    ),
    highValueThresholdUsd: readNumberEnv(
      'SENTINEL_HIGH_VALUE_THRESHOLD_USD',
      100_000,
    ),
    balanceDrainPct: readNumberEnv('SENTINEL_BALANCE_DRAIN_PCT', 80),
    creationSpikeWindowMs: readNumberEnv(
      'SENTINEL_CREATION_SPIKE_WINDOW_MS',
      5 * 60 * 1000,
    ),
    creationSpikeThreshold: readNumberEnv(
      'SENTINEL_CREATION_SPIKE_THRESHOLD',
      25,
    ),
    zeroRunwayMaxSeconds: readNumberEnv('SENTINEL_ZERO_RUNWAY_MAX_SECONDS', 60),
    zeroRunwayWindowMs: readNumberEnv(
      'SENTINEL_ZERO_RUNWAY_WINDOW_MS',
      5 * 60 * 1000,
    ),
    zeroRunwayFloodThreshold: readNumberEnv(
      'SENTINEL_ZERO_RUNWAY_FLOOD_THRESHOLD',
      50,
    ),
    alertCooldownMs: readNumberEnv('SENTINEL_ALERT_COOLDOWN_MS', 60_000),
    retentionMs: readNumberEnv(
      'SENTINEL_RETENTION_MS',
      24 * 60 * 60 * 1000,
    ),
    threatWindowMs: readNumberEnv('SENTINEL_THREAT_WINDOW_MS', 15 * 60 * 1000),
    ...(slackWebhookUrl ? { slackWebhookUrl } : {}),
    ...(discordWebhookUrl ? { discordWebhookUrl } : {}),
    ...(pagerDutyRoutingKey ? { pagerDutyRoutingKey } : {}),
    proposalSecret:
      readOptionalEnv('SENTINEL_PROPOSAL_SECRET') ??
      readOptionalEnv('JWT_SECRET') ??
      'flowfi-sentinel-dev-secret',
  };
}

// ─── Incidents ───────────────────────────────────────────────────────────────

/**
 * HMAC-signed request for the on-chain emergency pause. Signing proves the
 * proposal was generated by this service (and was not tampered with in transit
 * to the multisig signers' tooling); it is deliberately *not* a transaction
 * signature, so a leaked sentinel secret cannot move funds.
 */
export interface EmergencyPauseProposal {
  action: 'set_emergency_pause';
  value: true;
  incidentId: string;
  reason: string;
  requestedAt: string;
  payloadHash: string;
  signature: string;
  algorithm: 'hmac-sha256';
}

export interface SentinelIncident {
  id: string;
  ruleId: SentinelRuleId;
  severity: SentinelSeverity;
  title: string;
  description: string;
  address: string | null;
  token: string | null;
  streamId: string | null;
  ledger: number | null;
  detectedAt: string;
  threatScore: number;
  evidence: Record<string, unknown>;
  /** Present only for CRITICAL incidents. */
  circuitBreaker: EmergencyPauseProposal | null;
  /** True while the incident has not been reviewed via the admin API. */
  acknowledged: boolean;
}

export interface SentinelAlertDelivery {
  channel: 'slack' | 'discord' | 'pagerduty';
  ok: boolean;
  status?: number;
  error?: string;
}

export interface SentinelThreatSummary {
  score: number;
  level: SentinelSeverity | 'NONE';
  incidentCount: number;
  bySeverity: Record<SentinelSeverity, number>;
  windowMinutes: number;
  generatedAt: string;
}

export interface SentinelFlaggedAddress {
  address: string;
  threatScore: number;
  incidentCount: number;
  highestSeverity: SentinelSeverity;
  lastIncidentAt: string;
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface WithdrawalAnomalyInput {
  address: string;
  token: string;
  /** Raw i128 withdrawal amount as a string. */
  amount: string;
  /** USD valuation, when a price source is available. */
  amountUsd?: number;
  streamId: string;
  ledger: number;
  txHash: string;
  /** Total deposited into the stream the withdrawal came from. */
  streamDeposited?: string;
  now?: number;
}

export interface StreamCreationAnomalyInput {
  sender: string;
  token: string;
  streamId: string;
  /** Seconds of funding the stream has before it depletes. */
  runwaySeconds: number;
  ledger: number;
  now?: number;
}

export interface SentinelServiceDeps {
  tracker?: SlidingWindowTracker;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const MAX_INCIDENTS = 500;

function toNumber(value: string | number | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function truncate(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Sliding-window anomaly detector and alert dispatcher.
 *
 * Constructed with an explicit config + injected dependencies so the whole
 * thing is deterministic under test; production code uses the `sentinelService`
 * singleton below.
 */
export class SentinelService {
  private readonly config: SentinelConfig;
  private readonly tracker: SlidingWindowTracker;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly incidents: SentinelIncident[] = [];
  private readonly cooldowns = new Map<string, number>();
  /** Every tracker key touched this process, so `reset()` can clear them all. */
  private readonly trackedKeys = new Set<string>();

  constructor(
    config: SentinelConfig = getSentinelConfig(),
    deps: SentinelServiceDeps = {},
  ) {
    this.config = config;
    this.tracker = deps.tracker ?? getSlidingWindowTracker();
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    this.now = deps.now ?? (() => Date.now());
  }

  private registerKey(key: string): string {
    this.trackedKeys.add(key);
    return key;
  }

  // ── Observation entry points ────────────────────────────────────────────

  /**
   * Observe a withdrawal and evaluate every velocity/drain heuristic against
   * the freshly updated windows. Returns the incidents raised by *this* event
   * (an empty array when the withdrawal looks normal or the alert is cooling
   * down).
   */
  async recordWithdrawal(
    input: WithdrawalAnomalyInput,
  ): Promise<SentinelIncident[]> {
    if (!this.config.enabled) return [];
    const now = input.now ?? this.now();
    const amount = toNumber(input.amount);
    const notional = input.amountUsd ?? null;
    const weight = notional ?? amount;
    const detected: SentinelIncident[] = [];

    // 1) Per-wallet withdrawal velocity (count + volume).
    const walletKey = this.registerKey(`wallet_withdrawal_rate:${input.address}`);
    await this.tracker.add(walletKey, input.txHash, weight, now);
    const window = await this.tracker.snapshot(
      walletKey,
      this.config.velocityWindowMs,
      now,
    );
    const baseline = await this.tracker.snapshot(
      walletKey,
      this.config.baselineWindowMs,
      now,
    );
    const velocity = this.evaluateVelocity(
      window,
      baseline,
      this.config.velocityMinEvents,
    );
    if (velocity) {
      detected.push(
        this.makeIncident({
          ruleId: SENTINEL_RULES.VELOCITY_SPIKE,
          severity: velocity.severity,
          title: 'Withdrawal velocity spike',
          description:
            `Wallet ${truncate(input.address)} withdrew ${window.count} time(s) in ` +
            `${Math.round(this.config.velocityWindowMs / 1000)}s — ` +
            `${velocity.ratioLabel} the trailing baseline.`,
          address: input.address,
          token: input.token,
          streamId: input.streamId,
          ledger: input.ledger,
          now,
          evidence: {
            windowCount: window.count,
            windowVolume: window.sum,
            baselineVolumePerWindow: velocity.baselineAvg,
            increaseRatio: velocity.ratio,
            windowMs: this.config.velocityWindowMs,
            txHash: input.txHash,
          },
        }),
      );
    }

    // 2) Rapid multi-stream drain by a single address.
    const streamKey = this.registerKey(`wallet_withdrawal_streams:${input.address}`);
    const streamWindowMs =
      this.config.multiStreamWindowLedgers * LEDGER_MS;
    await this.tracker.add(streamKey, input.streamId, 1, now);
    const distinctStreams = await this.tracker.distinct(
      streamKey,
      streamWindowMs,
      now,
    );
    if (distinctStreams > this.config.multiStreamMaxStreams) {
      detected.push(
        this.makeIncident({
          ruleId: SENTINEL_RULES.MULTI_STREAM_DRAIN,
          severity:
            distinctStreams > this.config.multiStreamMaxStreams * 2
              ? 'CRITICAL'
              : 'HIGH',
          title: 'Rapid multi-stream drain',
          description:
            `Wallet ${truncate(input.address)} withdrew from ${distinctStreams} ` +
            `distinct streams within ${this.config.multiStreamWindowLedgers} ledgers.`,
          address: input.address,
          token: input.token,
          streamId: input.streamId,
          ledger: input.ledger,
          now,
          evidence: {
            distinctStreams,
            threshold: this.config.multiStreamMaxStreams,
            windowLedgers: this.config.multiStreamWindowLedgers,
            txHash: input.txHash,
          },
        }),
      );
    }

    // 3) High-value / near-total balance drain.
    const drain = this.evaluateDrain(input, amount, notional);
    if (drain) {
      detected.push(
        this.makeIncident({
          ruleId: SENTINEL_RULES.HIGH_VALUE_DRAIN,
          severity: drain.severity,
          title: 'High-value stream drain',
          description: drain.description,
          address: input.address,
          token: input.token,
          streamId: input.streamId,
          ledger: input.ledger,
          now,
          evidence: {
            amount: input.amount,
            amountUsd: notional,
            streamDeposited: input.streamDeposited ?? null,
            drainedPct: drain.drainedPct,
            txHash: input.txHash,
          },
        }),
      );
    }

    // 4) Token-wide velocity spike (catches distributed drains across many
    //    compromised wallets that individually stay under the per-wallet bar).
    const tokenKey = this.registerKey(`token_withdrawal_rate:${input.token}`);
    await this.tracker.add(tokenKey, input.txHash, weight, now);
    const tokenWindow = await this.tracker.snapshot(
      tokenKey,
      this.config.velocityWindowMs,
      now,
    );
    const tokenBaseline = await this.tracker.snapshot(
      tokenKey,
      this.config.baselineWindowMs,
      now,
    );
    const tokenVelocity = this.evaluateVelocity(
      tokenWindow,
      tokenBaseline,
      this.config.velocityMinEvents,
    );
    if (tokenVelocity) {
      detected.push(
        this.makeIncident({
          ruleId: SENTINEL_RULES.TOKEN_VELOCITY_SPIKE,
          severity: tokenVelocity.severity,
          title: 'Token withdrawal velocity spike',
          description:
            `Token ${truncate(input.token)} saw ${tokenWindow.count} withdrawals in ` +
            `${Math.round(this.config.velocityWindowMs / 1000)}s — ` +
            `${tokenVelocity.ratioLabel} the trailing baseline.`,
          address: input.address,
          token: input.token,
          streamId: input.streamId,
          ledger: input.ledger,
          now,
          evidence: {
            windowCount: tokenWindow.count,
            windowVolume: tokenWindow.sum,
            baselineVolumePerWindow: tokenVelocity.baselineAvg,
            increaseRatio: tokenVelocity.ratio,
            windowMs: this.config.velocityWindowMs,
          },
        }),
      );
    }

    return this.finalize(detected, now);
  }

  /**
   * Observe a stream creation and evaluate creation-spike and zero-runway
   * flood heuristics.
   */
  async recordStreamCreation(
    input: StreamCreationAnomalyInput,
  ): Promise<SentinelIncident[]> {
    if (!this.config.enabled) return [];
    const now = input.now ?? this.now();
    const detected: SentinelIncident[] = [];

    const tokenKey = this.registerKey(`stream_creation_spike:${input.token}`);
    await this.tracker.add(tokenKey, input.streamId, 1, now);
    const created = await this.tracker.distinct(
      tokenKey,
      this.config.creationSpikeWindowMs,
      now,
    );
    if (created > this.config.creationSpikeThreshold) {
      detected.push(
        this.makeIncident({
          ruleId: SENTINEL_RULES.STREAM_CREATION_SPIKE,
          severity:
            created > this.config.creationSpikeThreshold * 2 ? 'HIGH' : 'MEDIUM',
          title: 'Stream creation spike',
          description:
            `${created} streams for token ${truncate(input.token)} were created ` +
            `within ${Math.round(this.config.creationSpikeWindowMs / 60_000)} minutes.`,
          address: input.sender,
          token: input.token,
          streamId: input.streamId,
          ledger: input.ledger,
          now,
          evidence: {
            createdInWindow: created,
            threshold: this.config.creationSpikeThreshold,
            windowMs: this.config.creationSpikeWindowMs,
          },
        }),
      );
    }

    if (input.runwaySeconds < this.config.zeroRunwayMaxSeconds) {
      await this.tracker.add(
        this.registerKey('zero_runway_creations'),
        input.streamId,
        1,
        now,
      );
      const flood = await this.tracker.distinct(
        'zero_runway_creations',
        this.config.zeroRunwayWindowMs,
        now,
      );
      if (flood > this.config.zeroRunwayFloodThreshold) {
        detected.push(
          this.makeIncident({
            ruleId: SENTINEL_RULES.ZERO_RUNWAY_FLOOD,
            severity: 'CRITICAL',
            title: 'Zero-runway stream flood',
            description:
              `${flood} streams with under ${this.config.zeroRunwayMaxSeconds}s of ` +
              `runway were created in a burst — a classic dust-drain shape.`,
            address: input.sender,
            token: input.token,
            streamId: input.streamId,
            ledger: input.ledger,
            now,
            evidence: {
              zeroRunwayStreams: flood,
              threshold: this.config.zeroRunwayFloodThreshold,
              runwaySeconds: input.runwaySeconds,
            },
          }),
        );
      }
    }

    return this.finalize(detected, now);
  }

  // ── Heuristics ──────────────────────────────────────────────────────────

  /**
   * Compare a window aggregate against the trailing baseline. The baseline
   * excludes the current window so a spike cannot inflate its own reference.
   */
  private evaluateVelocity(
    window: SlidingWindowSnapshot,
    baseline: SlidingWindowSnapshot,
    minEvents: number,
  ): {
    severity: SentinelSeverity;
    ratio: number;
    ratioLabel: string;
    baselineAvg: number;
  } | null {
    if (window.count < minEvents || window.sum <= 0) return null;

    const baselineWindows =
      (this.config.baselineWindowMs - this.config.velocityWindowMs) /
      this.config.velocityWindowMs;
    const baselineAvg =
      baselineWindows > 0
        ? Math.max(0, baseline.sum - window.sum) / baselineWindows
        : 0;

    // Cold baseline: any meaningful burst is anomalous. Otherwise require the
    // configured multiple (default 4× == a 300% increase).
    const ratio =
      baselineAvg > 0 ? window.sum / baselineAvg : Number.POSITIVE_INFINITY;
    if (baselineAvg > 0 && ratio < this.config.velocitySpikeMultiplier) {
      return null;
    }

    const multiplier = this.config.velocitySpikeMultiplier;
    let severity: SentinelSeverity = 'MEDIUM';
    if (ratio >= multiplier * 3) severity = 'CRITICAL';
    else if (ratio >= multiplier * 1.5) severity = 'HIGH';

    return {
      severity,
      ratio,
      ratioLabel: Number.isFinite(ratio)
        ? `${ratio.toFixed(1)}×`
        : 'an unprecedented multiple of',
      baselineAvg,
    };
  }

  private evaluateDrain(
    input: WithdrawalAnomalyInput,
    amount: number,
    notional: number | null,
  ): { severity: SentinelSeverity; description: string; drainedPct: number | null } | null {
    const deposited = toNumber(input.streamDeposited);
    const drainedPct = deposited > 0 ? (amount / deposited) * 100 : null;

    const notionalBreach =
      notional !== null && notional >= this.config.highValueThresholdUsd;
    const balanceBreach =
      drainedPct !== null && drainedPct >= this.config.balanceDrainPct;
    if (!notionalBreach && !balanceBreach) return null;

    const critical =
      (notional !== null &&
        notional >= this.config.highValueThresholdUsd * 2) ||
      (drainedPct !== null && drainedPct >= 95);

    const description = notionalBreach
      ? `A single withdrawal of ~$${Math.round(notional as number).toLocaleString()} ` +
        `exceeded the high-value threshold of $${this.config.highValueThresholdUsd.toLocaleString()}.`
      : `A single withdrawal drained ${drainedPct?.toFixed(1)}% of stream ` +
        `${input.streamId}'s balance (threshold ${this.config.balanceDrainPct}%).`;

    return { severity: critical ? 'CRITICAL' : 'HIGH', description, drainedPct };
  }

  // ── Incident bookkeeping ────────────────────────────────────────────────

  private makeIncident(params: {
    ruleId: SentinelRuleId;
    severity: SentinelSeverity;
    title: string;
    description: string;
    address: string | null;
    token: string | null;
    streamId: string | null;
    ledger: number | null;
    now: number;
    evidence: Record<string, unknown>;
  }): SentinelIncident {
    return {
      id: crypto.randomUUID(),
      ruleId: params.ruleId,
      severity: params.severity,
      title: params.title,
      description: params.description,
      address: params.address,
      token: params.token,
      streamId: params.streamId,
      ledger: params.ledger,
      detectedAt: new Date(params.now).toISOString(),
      threatScore: SEVERITY_WEIGHT[params.severity],
      evidence: params.evidence,
      circuitBreaker: null,
      acknowledged: false,
    };
  }

  /**
   * Deduplicate (cooldown), persist, dispatch, and — for CRITICAL incidents —
   * attach a signed emergency-pause proposal. Shared by every rule.
   */
  private async finalize(
    incidents: SentinelIncident[],
    now: number,
  ): Promise<SentinelIncident[]> {
    const accepted: SentinelIncident[] = [];

    for (const incident of incidents) {
      const key = this.cooldownKey(incident);
      const lastAlertedAt = this.cooldowns.get(key);
      if (
        lastAlertedAt !== undefined &&
        now - lastAlertedAt < this.config.alertCooldownMs
      ) {
        continue;
      }
      this.cooldowns.set(key, now);

      if (incident.severity === 'CRITICAL') {
        incident.circuitBreaker = this.buildEmergencyPauseProposal(incident, now);
      }

      this.incidents.unshift(incident);
      sentinelIncidentsTotal.inc({ ruleId: incident.ruleId, severity: incident.severity });

      await this.dispatchAlert(incident);
      accepted.push(incident);
    }

    if (accepted.length > 0) {
      this.prune(now);
      setSentinelThreatScore(this.getThreatScore(now).score);
    }

    return accepted;
  }

  private cooldownKey(incident: SentinelIncident): string {
    return [
      incident.ruleId,
      incident.address ?? 'global',
      incident.token ?? '',
      incident.streamId ?? '',
    ].join('|');
  }

  private prune(now: number): void {
    const cutoff = now - this.config.retentionMs;
    while (this.incidents.length > 0) {
      const oldest = this.incidents[this.incidents.length - 1];
      if (
        this.incidents.length > MAX_INCIDENTS ||
        (oldest && Date.parse(oldest.detectedAt) < cutoff)
      ) {
        this.incidents.pop();
      } else {
        break;
      }
    }
    const cooldownCutoff = now - this.config.alertCooldownMs;
    for (const [key, at] of this.cooldowns) {
      if (at < cooldownCutoff) this.cooldowns.delete(key);
    }
  }

  /**
   * Build the HMAC-signed emergency-pause proposal handed to multisig signers.
   */
  buildEmergencyPauseProposal(
    incident: SentinelIncident,
    now = this.now(),
  ): EmergencyPauseProposal {
    const requestedAt = new Date(now).toISOString();
    const reason = `${incident.ruleId}: ${incident.title}`;
    const canonical = JSON.stringify({
      action: 'set_emergency_pause',
      value: true,
      incidentId: incident.id,
      reason,
      requestedAt,
    });
    return {
      action: 'set_emergency_pause',
      value: true,
      incidentId: incident.id,
      reason,
      requestedAt,
      payloadHash: crypto.createHash('sha256').update(canonical).digest('hex'),
      signature: crypto
        .createHmac('sha256', this.config.proposalSecret)
        .update(canonical)
        .digest('hex'),
      algorithm: 'hmac-sha256',
    };
  }

  // ── Alerting ────────────────────────────────────────────────────────────

  /**
   * Fan an incident out to every configured channel. Delivery failures are
   * recorded and logged but never thrown: a stale PagerDuty key must not stop
   * the next incident from being detected.
   */
  async dispatchAlert(
    incident: SentinelIncident,
  ): Promise<SentinelAlertDelivery[]> {
    const cfg = this.config;
    const channels: Array<{
      channel: SentinelAlertDelivery['channel'];
      url: string;
      body: unknown;
    }> = [];

    if (cfg.slackWebhookUrl) {
      channels.push({
        channel: 'slack',
        url: cfg.slackWebhookUrl,
        body: this.buildSlackPayload(incident),
      });
    }
    if (cfg.discordWebhookUrl) {
      channels.push({
        channel: 'discord',
        url: cfg.discordWebhookUrl,
        body: this.buildDiscordPayload(incident),
      });
    }
    if (cfg.pagerDutyRoutingKey) {
      channels.push({
        channel: 'pagerduty',
        url: 'https://events.pagerduty.com/v2/enqueue',
        body: this.buildPagerDutyPayload(incident),
      });
    }

    if (channels.length === 0) {
      logger.warn(
        `[Sentinel] ${incident.severity} ${incident.ruleId}: ${incident.description} ` +
          '(no alert channels configured)',
      );
      return [];
    }

    const deliveries = await Promise.all(
      channels.map(async ({ channel, url, body }): Promise<SentinelAlertDelivery> => {
        try {
          const response = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
          });
          const ok = response.status >= 200 && response.status < 300;
          sentinelAlertsDispatchedTotal.inc({
            channel,
            outcome: ok ? 'sent' : 'failed',
          });
          if (!ok) {
            logger.warn(
              `[Sentinel] ${channel} alert for ${incident.id} returned HTTP ${response.status}`,
            );
          }
          return { channel, ok, status: response.status };
        } catch (error) {
          sentinelAlertsDispatchedTotal.inc({ channel, outcome: 'error' });
          const message = error instanceof Error ? error.message : 'unknown error';
          logger.error(`[Sentinel] ${channel} alert for ${incident.id} failed:`, error);
          return { channel, ok: false, error: message };
        }
      }),
    );

    return deliveries;
  }

  private buildAlertContext(incident: SentinelIncident) {
    return {
      ruleId: incident.ruleId,
      severity: incident.severity,
      threatScore: incident.threatScore,
      address: incident.address,
      token: incident.token,
      streamId: incident.streamId,
      ledger: incident.ledger,
      detectedAt: incident.detectedAt,
      evidence: incident.evidence,
      circuitBreaker: incident.circuitBreaker,
    };
  }

  private buildSlackPayload(incident: SentinelIncident) {
    return {
      text: `🚨 [${incident.severity}] ${incident.title}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `*🚨 ${incident.severity} — ${incident.title}*\n${incident.description}` +
              (incident.circuitBreaker
                ? '\n*Circuit breaker:* signed `set_emergency_pause(true)` proposal attached — multisig action required.'
                : ''),
          },
        },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `incident \`${incident.id}\`` }] },
      ],
      sentinel: this.buildAlertContext(incident),
    };
  }

  private buildDiscordPayload(incident: SentinelIncident) {
    return {
      content: `🚨 **[${incident.severity}] ${incident.title}** — ${incident.description}`,
      embeds: [
        {
          title: `${incident.ruleId} (${incident.severity})`,
          description: incident.description,
          color: incident.severity === 'CRITICAL' ? 0xdc2626 : 0xf59e0b,
          timestamp: incident.detectedAt,
          fields: [
            ...(incident.address
              ? [{ name: 'Address', value: `\`${incident.address}\``, inline: true }]
              : []),
            ...(incident.token
              ? [{ name: 'Token', value: `\`${incident.token}\``, inline: true }]
              : []),
            { name: 'Threat score', value: String(incident.threatScore), inline: true },
          ],
        },
      ],
      sentinel: this.buildAlertContext(incident),
    };
  }

  private buildPagerDutyPayload(incident: SentinelIncident) {
    return {
      routing_key: this.config.pagerDutyRoutingKey,
      event_action: 'trigger',
      dedup_key: incident.id,
      payload: {
        summary: `[${incident.severity}] ${incident.title}: ${incident.description}`,
        source: 'flowfi-sentinel',
        severity:
          incident.severity === 'CRITICAL'
            ? 'critical'
            : incident.severity === 'HIGH'
              ? 'error'
              : incident.severity === 'MEDIUM'
                ? 'warning'
                : 'info',
        timestamp: incident.detectedAt,
        custom_details: this.buildAlertContext(incident),
      },
    };
  }

  // ── Read APIs (admin dashboard) ─────────────────────────────────────────

  /** Most recent incidents first, optionally filtered. */
  getAlerts(options: {
    severity?: SentinelSeverity;
    address?: string;
    limit?: number;
    now?: number;
  } = {}): SentinelIncident[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const cutoff =
      options.now !== undefined ? options.now - this.config.retentionMs : undefined;
    return this.incidents
      .filter(
        (incident) =>
          (!options.severity || incident.severity === options.severity) &&
          (!options.address || incident.address === options.address) &&
          (cutoff === undefined || Date.parse(incident.detectedAt) >= cutoff),
      )
      .slice(0, limit);
  }

  /** Aggregate 0-100 threat score derived from the trailing window. */
  getThreatScore(now = this.now()): SentinelThreatSummary {
    const cutoff = now - this.config.threatWindowMs;
    const bySeverity: Record<SentinelSeverity, number> = {
      LOW: 0,
      MEDIUM: 0,
      HIGH: 0,
      CRITICAL: 0,
    };

    let raw = 0;
    let incidentCount = 0;
    for (const incident of this.incidents) {
      if (Date.parse(incident.detectedAt) < cutoff) continue;
      incidentCount += 1;
      raw += SEVERITY_WEIGHT[incident.severity];
      bySeverity[incident.severity] += 1;
    }

    const score = Math.min(100, raw);
    const level: SentinelSeverity | 'NONE' =
      score === 0
        ? 'NONE'
        : score >= 80
          ? 'CRITICAL'
          : score >= 50
            ? 'HIGH'
            : score >= 25
              ? 'MEDIUM'
              : 'LOW';

    return {
      score,
      level,
      incidentCount,
      bySeverity,
      windowMinutes: Math.round(this.config.threatWindowMs / 60_000),
      generatedAt: new Date(now).toISOString(),
    };
  }

  /** Addresses implicated in recent incidents, ranked by accumulated score. */
  getFlaggedAddresses(now = this.now()): SentinelFlaggedAddress[] {
    const cutoff = now - this.config.threatWindowMs;
    const byAddress = new Map<string, SentinelFlaggedAddress>();

    for (const incident of this.incidents) {
      if (!incident.address) continue;
      if (Date.parse(incident.detectedAt) < cutoff) continue;

      const existing = byAddress.get(incident.address);
      if (!existing) {
        byAddress.set(incident.address, {
          address: incident.address,
          threatScore: incident.threatScore,
          incidentCount: 1,
          highestSeverity: incident.severity,
          lastIncidentAt: incident.detectedAt,
        });
        continue;
      }
      existing.threatScore = Math.min(100, existing.threatScore + incident.threatScore);
      existing.incidentCount += 1;
      existing.highestSeverity = higherSeverity(
        existing.highestSeverity,
        incident.severity,
      );
      if (incident.detectedAt > existing.lastIncidentAt) {
        existing.lastIncidentAt = incident.detectedAt;
      }
    }

    return [...byAddress.values()].sort((a, b) => b.threatScore - a.threatScore);
  }

  /** Mark an incident reviewed. Returns false when the id is unknown. */
  acknowledgeAlert(id: string): boolean {
    const incident = this.incidents.find((entry) => entry.id === id);
    if (!incident) return false;
    incident.acknowledged = true;
    return true;
  }

  /** Drop all retained state. Intended for tests and admin resets. */
  async reset(): Promise<void> {
    this.incidents.length = 0;
    this.cooldowns.clear();
    setSentinelThreatScore(0);
    for (const key of this.trackedKeys) {
      await this.tracker.clear(key);
    }
    this.trackedKeys.clear();
  }
}

/**
 * Process-wide sentinel used by the indexer hot path and the admin API.
 * Config is read lazily on first use so tests can mutate `process.env` before
 * importing.
 */
let _sentinel: SentinelService | null = null;

export function getSentinelService(): SentinelService {
  if (!_sentinel) {
    _sentinel = new SentinelService();
  }
  return _sentinel;
}

export const sentinelService = {
  recordWithdrawal: (input: WithdrawalAnomalyInput) =>
    getSentinelService().recordWithdrawal(input),
  recordStreamCreation: (input: StreamCreationAnomalyInput) =>
    getSentinelService().recordStreamCreation(input),
  dispatchAlert: (incident: SentinelIncident) =>
    getSentinelService().dispatchAlert(incident),
  getAlerts: (options?: Parameters<SentinelService['getAlerts']>[0]) =>
    getSentinelService().getAlerts(options),
  getThreatScore: () => getSentinelService().getThreatScore(),
  getFlaggedAddresses: () => getSentinelService().getFlaggedAddresses(),
  acknowledgeAlert: (id: string) => getSentinelService().acknowledgeAlert(id),
  buildEmergencyPauseProposal: (incident: SentinelIncident) =>
    getSentinelService().buildEmergencyPauseProposal(incident),
  reset: () => getSentinelService().reset(),
};

export default sentinelService;
