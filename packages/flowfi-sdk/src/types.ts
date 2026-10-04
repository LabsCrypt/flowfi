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
  status: 'Active' | 'Paused' | 'Cancelled' | 'Completed';
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
