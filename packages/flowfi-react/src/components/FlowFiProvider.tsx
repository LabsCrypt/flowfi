'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { FlowFiConfig } from '../types';

const FlowFiContext = createContext<FlowFiConfig | null>(null);

export interface FlowFiProviderProps extends Partial<FlowFiConfig> {
  children: ReactNode;
  config?: FlowFiConfig;
}

export function FlowFiProvider({ children, config, ...rest }: FlowFiProviderProps) {
  const value = useMemo<FlowFiConfig>(
    () => ({
      rpcUrl: config?.rpcUrl ?? rest.rpcUrl ?? '',
      contractId: config?.contractId ?? rest.contractId ?? '',
      networkPassphrase: config?.networkPassphrase ?? rest.networkPassphrase ?? '',
      walletAddress: config?.walletAddress ?? rest.walletAddress,
    }),
    [config, rest.rpcUrl, rest.contractId, rest.networkPassphrase, rest.walletAddress],
  );

  return <FlowFiContext.Provider value={value}>{children}</FlowFiContext.Provider>;
}

export function useFlowFiConfig(): FlowFiConfig {
  const ctx = useContext(FlowFiContext);
  if (!ctx) {
    // Non-fatal fallback so the hooks remain usable in isolation.
    return { rpcUrl: '', contractId: '', networkPassphrase: '' };
  }
  return ctx;
}
