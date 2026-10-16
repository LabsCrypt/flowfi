"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { getNetworkConfig, NETWORK_CONFIGS, type NetworkConfig, type NetworkId } from "@/lib/stellar-config";

const STORAGE_KEY = "flowfi.network";
const DEFAULT_NETWORK: NetworkId = "testnet";
interface NetworkContextValue { network: NetworkConfig; networkId: NetworkId; setNetworkId: (id: NetworkId) => void; isHydrated: boolean; }
const NetworkContext = createContext<NetworkContextValue | undefined>(undefined);

// localStorage is an external store, so it is read through useSyncExternalStore
// instead of mirroring it into state from an effect. React hydrates with the
// server snapshot and then adopts the stored value, which keeps the server and
// client markup in sync without a setState-in-effect cascade.
const listeners = new Set<() => void>();

function subscribeToStorage(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

function readStoredNetworkId(): NetworkId {
  const stored = window.localStorage.getItem(STORAGE_KEY) as NetworkId | null;
  return stored && stored in NETWORK_CONFIGS ? stored : DEFAULT_NETWORK;
}

const getServerNetworkId = () => DEFAULT_NETWORK;
const subscribeToNothing = () => () => {};
const readHydratedOnClient = () => true;
const readHydratedOnServer = () => false;

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const networkId = useSyncExternalStore(subscribeToStorage, readStoredNetworkId, getServerNetworkId);
  const isHydrated = useSyncExternalStore(subscribeToNothing, readHydratedOnClient, readHydratedOnServer);
  const setPersistedNetwork = useCallback((id: NetworkId) => { window.localStorage.setItem(STORAGE_KEY, id); listeners.forEach((listener) => listener()); }, []);
  const value = useMemo(() => ({ network: getNetworkConfig(networkId), networkId, setNetworkId: setPersistedNetwork, isHydrated }), [networkId, isHydrated, setPersistedNetwork]);
  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkContextValue { const context = useContext(NetworkContext); if (!context) throw new Error("useNetwork must be used within NetworkProvider"); return context; }
