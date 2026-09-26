"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { getNetworkConfig, NETWORK_CONFIGS, type NetworkConfig, type NetworkId } from "@/lib/stellar-config";

const STORAGE_KEY = "flowfi.network";
interface NetworkContextValue { network: NetworkConfig; networkId: NetworkId; setNetworkId: (id: NetworkId) => void; isHydrated: boolean; }
const NetworkContext = createContext<NetworkContextValue | undefined>(undefined);

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [networkId, setNetworkId] = useState<NetworkId>("testnet"); const [isHydrated, setHydrated] = useState(false);
  useEffect(() => { const stored = window.localStorage.getItem(STORAGE_KEY) as NetworkId | null; if (stored && stored in NETWORK_CONFIGS) setNetworkId(stored); setHydrated(true); }, []);
  const setPersistedNetwork = (id: NetworkId) => { setNetworkId(id); window.localStorage.setItem(STORAGE_KEY, id); };
  const value = useMemo(() => ({ network: getNetworkConfig(networkId), networkId, setNetworkId: setPersistedNetwork, isHydrated }), [networkId, isHydrated]);
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkContextValue { const context = useContext(NetworkContext); if (!context) throw new Error("useNetwork must be used within NetworkProvider"); return context; }