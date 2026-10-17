/**
 * Compliance / sanctions screening service (Issue #1470)
 *
 * Screens Stellar wallet addresses against sanctions data before funds move and
 * records an audit trail of every decision. Two provider modes are supported:
 *
 * - `local`    : in-process denylist/allowlist plus an optional JSON sanctions
 *                feed (e.g. a periodically refreshed OFAC SDN export).
 * - `external` : an external screening provider (Chainalysis, TRM Labs,
 *                Elliptic, …) reached over HTTPS.
 *
 * Results are cached with a configurable TTL (Redis when available, otherwise
 * the bounded in-process `MemoryCache`) so repeated screens of the same address
 * do not re-hit an external provider.
 */
import { readFileSync } from 'node:fs';
import logger from '../logger.js';
import { cache, getPublisher, isRedisAvailable } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import {
  getComplianceConfig,
  type ComplianceConfig,
} from '../config/compliance.config.js';

/**
 * Result of screening a single address.
 */
export interface ScreeningResult {
  address: string;
  isSanctioned: boolean;
  riskScore: number; // 0 (clean) to 100 (blocked)
  tags: string[]; // e.g. ["OFAC", "Darknet", "Ransomware"]
  screenedAt: Date;
  cached: boolean;
}

/** Provider output before address/timestamp/cache fields are attached. */
type ProviderResult = Omit<ScreeningResult, 'address' | 'screenedAt' | 'cached'>;

/** Thrown when a screening provider cannot produce a trustworthy answer. */
export class ComplianceScreeningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComplianceScreeningError';
  }
}

/** Audit event persisted for blocked / failed screening and KYC submissions. */
export interface ComplianceAuditEvent {
  eventType: string;
  address: string;
  ipAddress?: string;
  riskScore: number;
  tags: string[];
  isSanctioned: boolean;
  action?: string;
  metadata?: Record<string, unknown>;
}

const CACHE_KEY_PREFIX = 'compliance:screening:';

/**
 * Cache key for a screening result. The provider is part of the key so that
 * switching between `local` and `external` never serves a stale result.
 */
function screeningCacheKey(address: string, config: ComplianceConfig): string {
  return `${CACHE_KEY_PREFIX}${config.provider}:${address}`;
}

/** Lazy-loaded sanctions feeds keyed by file path. */
const sanctionsFileCache = new Map<string, Map<string, string[]>>();

/** Parsed allow/deny lookups keyed by a config fingerprint (avoids re-parsing). */
let denylistIndex: { fingerprint: string; entries: Map<string, string[]> } | null = null;

function configFingerprint(config: ComplianceConfig): string {
  return `${config.denylist.join(',')}|${config.sanctionsFilePath ?? ''}`;
}

/**
 * Load an optional JSON sanctions feed. Tolerant of the shapes commonly
 * exported by sanctions vendors:
 *
 * - `["GABC...", "GDEF..."]`
 * - `[{ "address": "GABC...", "tags": ["OFAC"], "program": "SDN" }]`
 * - `{ "addresses": ["GABC..."] }`
 * - `{ "GABC...": ["OFAC"] }`
 */
function loadSanctionsFile(filePath: string): Map<string, string[]> {
  const cached = sanctionsFileCache.get(filePath);
  if (cached) {
    return cached;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new ComplianceScreeningError(
      `Unable to read sanctions feed '${filePath}': ${(error as Error).message}`,
    );
  }

  const entries = new Map<string, string[]>();

  const addEntry = (address: unknown, tags: string[]) => {
    if (typeof address === 'string' && address.trim()) {
      entries.set(address.trim(), tags.length > 0 ? tags : ['OFAC']);
    }
  };

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (typeof item === 'string') {
        addEntry(item, ['OFAC']);
      } else if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const tags = Array.isArray(record.tags)
          ? record.tags.filter((tag): tag is string => typeof tag === 'string')
          : [];
        if (typeof record.program === 'string') tags.push(record.program);
        addEntry(record.address, tags);
      }
    }
  } else if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.addresses)) {
      for (const address of record.addresses) addEntry(address, ['OFAC']);
    } else {
      for (const [address, value] of Object.entries(record)) {
        const tags = Array.isArray(value)
          ? value.filter((tag): tag is string => typeof tag === 'string')
          : [];
        addEntry(address, tags);
      }
    }
  }

  sanctionsFileCache.set(filePath, entries);
  return entries;
}

/** Build (and cache) the combined denylist lookup for the given config. */
function getDenylistIndex(config: ComplianceConfig): Map<string, string[]> {
  const fingerprint = configFingerprint(config);
  if (denylistIndex && denylistIndex.fingerprint === fingerprint) {
    return denylistIndex.entries;
  }

  const entries = new Map<string, string[]>();
  if (config.sanctionsFilePath) {
    for (const [address, tags] of loadSanctionsFile(config.sanctionsFilePath)) {
      entries.set(address, tags);
    }
  }
  for (const address of config.denylist) {
    entries.set(address, ['OFAC']);
  }

  denylistIndex = { fingerprint, entries };
  return entries;
}

/**
 * Local provider: allowlist wins, then the denylist/sanctions feed, otherwise
 * the address is considered clean.
 */
function localScreen(address: string, config: ComplianceConfig): ProviderResult {
  const normalized = address.trim();

  if (config.allowlist.includes(normalized)) {
    return { isSanctioned: false, riskScore: 0, tags: ['ALLOWLIST'] };
  }

  const tags = getDenylistIndex(config).get(normalized);
  if (tags) {
    return { isSanctioned: true, riskScore: 100, tags };
  }

  return { isSanctioned: false, riskScore: 0, tags: [] };
}

function clampRiskScore(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

function normalizeExternalPayload(payload: unknown): ProviderResult {
  const record =
    payload && typeof payload === 'object'
      ? ((payload as Record<string, unknown>).data as Record<string, unknown>) ??
        (payload as Record<string, unknown>)
      : {};

  const isSanctioned = record.isSanctioned === true;
  const riskScore = clampRiskScore(record.riskScore, isSanctioned ? 100 : 0);
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];

  return { isSanctioned, riskScore, tags };
}

/**
 * External provider: POST `{ address }` to the configured endpoint, forwarding
 * the API key as a bearer token, with an abort-based timeout.
 */
async function externalScreen(
  address: string,
  config: ComplianceConfig,
): Promise<ProviderResult> {
  if (!config.externalApiUrl) {
    throw new ComplianceScreeningError(
      'COMPLIANCE_EXTERNAL_API_URL is not configured for the external provider.',
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.externalApiTimeoutMs);

  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.externalApiKey) {
      headers.authorization = `Bearer ${config.externalApiKey}`;
    }

    const response = await fetch(config.externalApiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ address }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ComplianceScreeningError(
        `External screening provider returned HTTP ${response.status}.`,
      );
    }

    const payload: unknown = await response.json();
    return normalizeExternalPayload(payload);
  } catch (error) {
    if (error instanceof ComplianceScreeningError) throw error;
    throw new ComplianceScreeningError(
      `External screening provider request failed: ${(error as Error).message}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Screening cache TTL in seconds for the active config. */
function resolveTtlSeconds(config: ComplianceConfig): number {
  return config.cacheTtlSeconds;
}

async function readCachedResult(
  address: string,
  config: ComplianceConfig,
): Promise<ScreeningResult | null> {
  const key = screeningCacheKey(address, config);

  if (isRedisAvailable()) {
    const client = getPublisher();
    if (client) {
      try {
        const raw = await client.get(key);
        if (raw) {
          return { ...(JSON.parse(raw) as ScreeningResult), cached: true };
        }
        return null;
      } catch (error) {
        logger.warn(`[Compliance] Redis cache read failed: ${(error as Error).message}`);
      }
    }
  }

  const cached = cache.get<ScreeningResult>(key);
  if (cached) {
    return { ...cached, cached: true };
  }
  return null;
}

async function writeCachedResult(
  address: string,
  result: ScreeningResult,
  config: ComplianceConfig,
): Promise<void> {
  const key = screeningCacheKey(address, config);
  const ttl = resolveTtlSeconds(config);

  // Never serve a stale `cached: true` flag to a fresh caller.
  const stored: ScreeningResult = { ...result, cached: false };

  if (isRedisAvailable()) {
    const client = getPublisher();
    if (client) {
      try {
        await client.set(key, JSON.stringify(stored), 'EX', ttl);
        return;
      } catch (error) {
        logger.warn(`[Compliance] Redis cache write failed: ${(error as Error).message}`);
      }
    }
  }

  cache.set(key, stored, ttl);
}

/**
 * Compliance service: screening, risk evaluation and audit persistence.
 */
export class ComplianceService {
  /**
   * Screen a single address, using the cache when possible.
   *
   * Throws {@link ComplianceScreeningError} when the provider cannot produce a
   * trustworthy answer; callers decide how to apply the configured failure mode.
   */
  async screenAddress(
    address: string,
    config: ComplianceConfig = getComplianceConfig(),
  ): Promise<ScreeningResult> {
    const normalized = address.trim();

    const cached = await readCachedResult(normalized, config);
    if (cached) {
      return cached;
    }

    const providerResult =
      config.provider === 'external'
        ? await externalScreen(normalized, config)
        : localScreen(normalized, config);

    const result: ScreeningResult = {
      address: normalized,
      isSanctioned: providerResult.isSanctioned,
      riskScore: providerResult.riskScore,
      tags: providerResult.tags,
      screenedAt: new Date(),
      cached: false,
    };

    await writeCachedResult(normalized, result, config);
    return result;
  }

  /** Screen many addresses in parallel, deduplicating input. */
  async screenAddresses(
    addresses: string[],
    config: ComplianceConfig = getComplianceConfig(),
  ): Promise<ScreeningResult[]> {
    const unique = Array.from(new Set(addresses.map((a) => a.trim()).filter(Boolean)));
    return Promise.all(unique.map((address) => this.screenAddress(address, config)));
  }

  /**
   * A result is blocked when the address is explicitly sanctioned or its risk
   * score exceeds the configured threshold.
   */
  isBlocked(result: ScreeningResult, config: ComplianceConfig): boolean {
    return result.isSanctioned || result.riskScore > config.riskThreshold;
  }

  /**
   * Persist an audit event and emit a structured log line.
   *
   * Audit logging must never break the request path: database failures are
   * downgraded to a warning and the structured log is always emitted.
   */
  async writeAuditLog(event: ComplianceAuditEvent): Promise<void> {
    logger.info('[Compliance][audit]', {
      audit: true,
      eventType: event.eventType,
      action: event.action,
      address: event.address,
      ipAddress: event.ipAddress,
      riskScore: event.riskScore,
      tags: event.tags,
      isSanctioned: event.isSanctioned,
    });

    try {
      await prisma.complianceAuditLog.create({
        data: {
          eventType: event.eventType,
          action: event.action ?? null,
          address: event.address,
          ipAddress: event.ipAddress ?? null,
          riskScore: event.riskScore,
          tags: event.tags,
          isSanctioned: event.isSanctioned,
          metadata: event.metadata ? JSON.stringify(event.metadata) : null,
        },
      });
    } catch (error) {
      logger.warn(
        `[Compliance] Failed to persist audit log for ${event.address}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Store a SEP-0009 KYC attestation submitted by an organization.
   */
  async submitKycAttestation(input: {
    organization: string;
    subjectAddress: string;
    sep9Fields: Record<string, unknown>;
    proof: string;
    proofType?: string;
  }) {
    const attestation = await prisma.kycAttestation.create({
      data: {
        organization: input.organization,
        subjectAddress: input.subjectAddress,
        sep9Fields: JSON.stringify(input.sep9Fields),
        proof: input.proof,
        proofType: input.proofType ?? null,
        status: 'PENDING',
      },
    });

    await this.writeAuditLog({
      eventType: 'KYC_ATTESTATION_SUBMITTED',
      address: input.subjectAddress,
      riskScore: 0,
      tags: [],
      isSanctioned: false,
      action: 'compliance.kyc_attestation',
      metadata: { organization: input.organization, attestationId: attestation.id },
    });

    return attestation;
  }

  /** Test helper: drop the in-process screening cache and parsed sanctions feeds. */
  clearScreeningCache(): void {
    sanctionsFileCache.clear();
    denylistIndex = null;
  }
}

export const complianceService = new ComplianceService();
