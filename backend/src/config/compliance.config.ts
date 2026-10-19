/**
 * Compliance / Sanctions Screening Configuration (Issue #1470)
 *
 * FlowFi is used for institutional payroll and regulated token distributions on
 * Stellar. Before any stream is funded or withdrawn, the API can screen the
 * participating wallet addresses against sanctions data (OFAC SDN and friends)
 * and a configurable risk threshold.
 *
 * Every setting is opt-in so the open-source default stays fully permissive:
 * `COMPLIANCE_ENFORCEMENT_ENABLED` defaults to `false`, preserving local
 * testing and self-hosted sovereignty.
 */

/**
 * How the middleware reacts when the screening provider itself fails
 * (network error, timeout, malformed response).
 *
 * - `fail-closed`: block the request (safe default for regulated deployments).
 * - `fail-open`:   allow the request and record an audit event.
 */
export type ComplianceFailureMode = 'fail-open' | 'fail-closed';

/**
 * Screening data source.
 *
 * - `local`:    in-process denylist / allowlist (inline env + optional JSON
 *               sanctions feed). Zero external dependencies.
 * - `external`: a screening provider (Chainalysis, TRM Labs, Elliptic, …)
 *               reached over HTTPS.
 */
export type ComplianceProviderName = 'local' | 'external';

export interface ComplianceConfig {
  /** Master switch. When false the middleware is a no-op pass-through. */
  enforcementEnabled: boolean;
  /** Addresses with `riskScore > riskThreshold` are blocked (0–100). */
  riskThreshold: number;
  /** Behaviour when the screening provider errors out. */
  failureMode: ComplianceFailureMode;
  /** TTL (seconds) for cached screening results, default 24h. */
  cacheTtlSeconds: number;
  /** Screening data source. */
  provider: ComplianceProviderName;
  /** External provider endpoint (required when provider === 'external'). */
  externalApiUrl?: string;
  /** Bearer/API key forwarded to the external provider. */
  externalApiKey?: string;
  /** External provider request timeout in milliseconds. */
  externalApiTimeoutMs: number;
  /** Always-allowed addresses (checked before the denylist). */
  allowlist: string[];
  /** Always-blocked addresses. */
  denylist: string[];
  /** Optional path to a JSON sanctions feed loaded at runtime. */
  sanctionsFilePath?: string;
}

const DEFAULT_RISK_THRESHOLD = 70;
const DEFAULT_CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const DEFAULT_EXTERNAL_TIMEOUT_MS = 5_000;

/**
 * Strictly validate boolean environment variables.
 *
 * Accepted values are exactly `'true'` / `'false'`; anything else throws so a
 * typo can never silently disable compliance enforcement.
 */
function parseBooleanEnv(
  varName: string,
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(
    `${varName} has invalid value '${value}'. Expected one of: 'true', 'false'.`,
  );
}

function parseNumberEnv(
  varName: string,
  value: string | undefined,
  defaultValue: number,
  { min, max }: { min: number; max: number },
): number {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${varName} has invalid value '${value}'. Expected an integer.`);
  }

  if (parsed < min || parsed > max) {
    throw new Error(
      `${varName} has invalid value '${value}'. Expected an integer between ${min} and ${max}.`,
    );
  }

  return parsed;
}

function parseFailureMode(value: string | undefined): ComplianceFailureMode {
  if (value === undefined || value === '') {
    return 'fail-closed';
  }
  if (value === 'fail-open' || value === 'fail-closed') {
    return value;
  }
  throw new Error(
    `COMPLIANCE_FAILURE_MODE has invalid value '${value}'. Expected one of: 'fail-open', 'fail-closed'.`,
  );
}

function parseProvider(value: string | undefined): ComplianceProviderName {
  if (value === undefined || value === '') {
    return 'local';
  }
  if (value === 'local' || value === 'external') {
    return value;
  }
  throw new Error(
    `COMPLIANCE_PROVIDER has invalid value '${value}'. Expected one of: 'local', 'external'.`,
  );
}

function parseAddressList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Resolve compliance configuration from the environment.
 *
 * Read at call time (not module load) so tests and long-running processes can
 * toggle enforcement without a restart.
 */
export function getComplianceConfig(): ComplianceConfig {
  const config: ComplianceConfig = {
    enforcementEnabled: parseBooleanEnv(
      'COMPLIANCE_ENFORCEMENT_ENABLED',
      process.env.COMPLIANCE_ENFORCEMENT_ENABLED,
      false,
    ),
    riskThreshold: parseNumberEnv(
      'COMPLIANCE_RISK_THRESHOLD',
      process.env.COMPLIANCE_RISK_THRESHOLD,
      DEFAULT_RISK_THRESHOLD,
      { min: 0, max: 100 },
    ),
    failureMode: parseFailureMode(process.env.COMPLIANCE_FAILURE_MODE),
    cacheTtlSeconds: parseNumberEnv(
      'COMPLIANCE_CACHE_TTL_SECONDS',
      process.env.COMPLIANCE_CACHE_TTL_SECONDS,
      DEFAULT_CACHE_TTL_SECONDS,
      { min: 0, max: 30 * 24 * 60 * 60 },
    ),
    provider: parseProvider(process.env.COMPLIANCE_PROVIDER),
    externalApiTimeoutMs: parseNumberEnv(
      'COMPLIANCE_EXTERNAL_API_TIMEOUT_MS',
      process.env.COMPLIANCE_EXTERNAL_API_TIMEOUT_MS,
      DEFAULT_EXTERNAL_TIMEOUT_MS,
      { min: 100, max: 60_000 },
    ),
    allowlist: parseAddressList(process.env.COMPLIANCE_ALLOWLIST),
    denylist: parseAddressList(process.env.COMPLIANCE_DENYLIST),
  };

  const externalApiUrl = process.env.COMPLIANCE_EXTERNAL_API_URL;
  if (externalApiUrl) {
    config.externalApiUrl = externalApiUrl;
  }

  const externalApiKey = process.env.COMPLIANCE_EXTERNAL_API_KEY;
  if (externalApiKey) {
    config.externalApiKey = externalApiKey;
  }

  const sanctionsFilePath = process.env.COMPLIANCE_SANCTIONS_FILE;
  if (sanctionsFilePath) {
    config.sanctionsFilePath = sanctionsFilePath;
  }

  return config;
}

/** Whether the compliance middleware should run at all. */
export function isComplianceEnforcementEnabled(): boolean {
  return getComplianceConfig().enforcementEnabled;
}
