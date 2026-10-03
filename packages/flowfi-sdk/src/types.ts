/**
 * Shared SDK types for FlowFi Soroban transaction building.
 *
 * Amounts are expressed in stroops (i128) as `bigint` to avoid precision loss
 * beyond `Number.MAX_SAFE_INTEGER`. Stream IDs map to the contract's `u64`.
 */

export interface FlowFiClientConfig {
  /** Soroban RPC endpoint, e.g. `https://soroban-testnet.stellar.org`. */
  rpcUrl: string;
  /** Network passphrase, e.g. `Test SDF Network ; September 2015`. */
  networkPassphrase: string;
  /** Deployed `stream_contract` contract ID (C... address). */
  contractId: string;
  /**
   * Safety multiplier applied on top of the simulated resource fee.
   * `1.2` means "charge 20% more than simulation". Defaults to `1.25`.
   */
  feeBufferMultiplier?: number;
}

export interface CreateStreamParams {
  sender: string;
  recipient: string;
  tokenAddress: string;
  /** Gross amount in stroops. Must be > 0. */
  amount: bigint;
  /** Stream duration in seconds. Must be > 0. */
  duration: number;
  /** Optional vesting cliff in seconds (0 < cliff <= duration). */
  cliffDuration?: number;
}

/**
 * Lifecycle status of a payment stream, mirroring the contract's
 * `StreamStatus` enum (Active, Paused, Cancelled, Completed).
 */
export type StreamStatus = 'Active' | 'Paused' | 'Cancelled' | 'Completed';

/**
 * How a stream's tokens unlock over time, mirroring the contract's
 * `VestingSchedule` enum:
 * - `linear` — continuous drip at the stream's rate per second.
 * - `step_tranches` — milestone tranches, each unlocking a fixed amount at an
 *   absolute timestamp.
 * - `hybrid_cliff_linear` — a lump-sum cliff unlock followed by a linear drip.
 */
export type VestingSchedule =
  | { kind: 'linear' }
  | { kind: 'step_tranches'; steps: VestingStep[] }
  | { kind: 'hybrid_cliff_linear'; cliffTime: bigint; cliffUnlockAmount: bigint };

/**
 * A single discrete unlock of a step-tranche (milestone) vesting schedule.
 */
export interface VestingStep {
  /** Absolute ledger timestamp (Unix epoch seconds) at which the tranche unlocks. */
  unlockTime: number | bigint;
  /** Amount unlocked at `unlockTime`, in stroops. */
  unlockAmount: bigint | number;
}

export interface StreamDetails {
  streamId: bigint;
  sender: string;
  recipient: string;
  tokenAddress: string;
  ratePerSecond: bigint;
  depositedAmount: bigint;
  withdrawnAmount: bigint;
  startTime: bigint;
  lastUpdateTime: bigint;
  cliffTime?: bigint | null;
  isActive: boolean;
  paused: boolean;
  status: StreamStatus;
  /** Unlock curve for the stream, when the data source provides it. */
  schedule?: VestingSchedule;
}

// ─── Runtime type guards ──────────────────────────────────────────────────────

const STREAM_STATUSES: readonly StreamStatus[] = ['Active', 'Paused', 'Cancelled', 'Completed'];

/**
 * Runtime type guard narrowing `unknown` to `StreamStatus`.
 *
 * Data decoded from RPC/JSON (e.g. via the Soroban RPC `scValToNative` or a
 * backend response) arrives untyped; this guard validates the string against
 * the contract's `StreamStatus` variants before callers rely on it.
 *
 * @param value - Value to validate.
 * @returns `true` when `value` is one of `'Active' | 'Paused' | 'Cancelled' | 'Completed'`.
 *
 * @example
 * ```ts
 * if (isStreamStatus(raw.status)) {
 *   // raw.status is narrowed to StreamStatus
 * }
 * ```
 */
export function isStreamStatus(value: unknown): value is StreamStatus {
  return (
    typeof value === 'string' && (STREAM_STATUSES as readonly string[]).includes(value)
  );
}

function isVestingStep(value: unknown): value is VestingStep {
  if (typeof value !== 'object' || value === null) return false;
  const step = value as Record<string, unknown>;
  return (
    (typeof step.unlockTime === 'number' || typeof step.unlockTime === 'bigint') &&
    (typeof step.unlockAmount === 'number' || typeof step.unlockAmount === 'bigint')
  );
}

/**
 * Runtime type guard narrowing `unknown` to `VestingSchedule`.
 *
 * Accepts the discriminated-union JSON shape produced by the backend indexer
 * (`{ kind: 'linear' | 'step_tranches' | 'hybrid_cliff_linear', ... }`) and
 * validates each variant's payload: step times/amounts for `step_tranches`,
 * numeric cliff fields for `hybrid_cliff_linear`.
 *
 * @param value - Value to validate.
 * @returns `true` when `value` is a well-formed {@link VestingSchedule}.
 *
 * @example
 * ```ts
 * if (isVestingSchedule(raw.schedule)) {
 *   // raw.schedule is narrowed to VestingSchedule
 * }
 * ```
 */
export function isVestingSchedule(value: unknown): value is VestingSchedule {
  if (typeof value !== 'object' || value === null) return false;
  const schedule = value as Record<string, unknown>;

  switch (schedule.kind) {
    case 'linear':
      return true;
    case 'step_tranches':
      return (
        Array.isArray(schedule.steps) && schedule.steps.every(isVestingStep)
      );
    case 'hybrid_cliff_linear':
      return (
        (typeof schedule.cliffTime === 'number' || typeof schedule.cliffTime === 'bigint') &&
        (typeof schedule.cliffUnlockAmount === 'number' ||
          typeof schedule.cliffUnlockAmount === 'bigint')
      );
    default:
      return false;
  }
}

export interface StreamResult {
  streamId: bigint;
  transactionHash: string;
}

export interface WithdrawResult {
  streamId: bigint;
  amount: bigint;
  transactionHash: string;
}

export interface SubmitResult {
  transactionHash: string;
}
