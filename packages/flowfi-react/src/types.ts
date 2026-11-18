export interface FlowFiStream {
  id: string;
  sender: string;
  recipient: string;
  token: {
    symbol: string;
    address: string;
    decimals: number;
  };
  /** Raw base-unit amounts as decimal strings. */
  depositedAmount: string;
  withdrawnAmount: string;
  remainingBalance: string;
  claimableBalance: string;
  startTimestamp: number;
  endTimestamp: number;
  cliffTimestamp: number;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  /** Optional USD price per whole token. */
  usdRate?: number;
}

export interface CreateStreamParams {
  sender: string;
  recipient: string;
  tokenAddress: string;
  tokenDecimals: number;
  tokenSymbol: string;
  depositedAmount: string;
  startTimestamp: number;
  endTimestamp: number;
  cliffTimestamp: number;
  memo?: string;
}

export type CreateStreamState =
  | 'idle'
  | 'simulating'
  | 'signing'
  | 'broadcasting'
  | 'confirmed'
  | 'error';

export interface FlowFiConfig {
  /** Soroban RPC URL. */
  rpcUrl: string;
  /** FlowFi contract ID. */
  contractId: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
  /** Wallet address currently connected (optional). */
  walletAddress?: string;
}
