"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { getNetworkConfig, NETWORK_CONFIGS, type NetworkConfig, type NetworkId } from "@/lib/stellar-config";

const STORAGE_KEY = "flowfi.network";
interface NetworkContextValue { network: NetworkConfig; networkId: NetworkId; setNetworkId: (id: NetworkId) => void; isHydrated: boolean; }
const NetworkContext = createContext<NetworkContextValue | undefined>(undefined);

/**
 * `localStorage` is an external store, so it is read through
 * `useSyncExternalStore` rather than a mount effect that calls `setState`:
 * React then uses the server snapshot while hydrating, which is what keeps the
 * server-rendered default network and the client-rendered persisted one from
 * disagreeing. Writes notify subscribers manually because the `storage` event
 * only fires in *other* tabs.
 */
const storeListeners = new Set<() => void>();

function subscribeToStoredNetwork(onChange: () => void) {
  storeListeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    storeListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function getStoredNetworkSnapshot(): NetworkId | null {
  const stored = window.localStorage.getItem(STORAGE_KEY) as NetworkId | null;
  return stored && stored in NETWORK_CONFIGS ? stored : null;
}

/** There is no localStorage during SSR, so render the default until hydration. */
function getServerNetworkSnapshot(): NetworkId | null { return null; }

/** Never notifies: the fact that this snapshot is readable at all means we are hydrated. */
function subscribeToHydration() { return () => {}; }
const getHydratedSnapshot = () => true;
const getServerHydratedSnapshot = () => false;

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const storedNetworkId = useSyncExternalStore(subscribeToStoredNetwork, getStoredNetworkSnapshot, getServerNetworkSnapshot);
  const isHydrated = useSyncExternalStore(subscribeToHydration, getHydratedSnapshot, getServerHydratedSnapshot);
  const networkId = storedNetworkId ?? "testnet";
  const setPersistedNetwork = useCallback((id: NetworkId) => {
    if (!(id in NETWORK_CONFIGS)) return;
    window.localStorage.setItem(STORAGE_KEY, id);
    storeListeners.forEach((notify) => notify());
  }, []);
  const value = useMemo(() => ({ network: getNetworkConfig(networkId), networkId, setNetworkId: setPersistedNetwork, isHydrated }), [networkId, setPersistedNetwork, isHydrated]);
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkContextValue { const context = useContext(NetworkContext); if (!context) throw new Error("useNetwork must be used within NetworkProvider"); return context; }
