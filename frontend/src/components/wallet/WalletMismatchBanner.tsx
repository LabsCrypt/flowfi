"use client";

import { AlertTriangle, ArrowLeftRight, RefreshCw } from "lucide-react";
import { useWallet } from "@/context/wallet-context";
import { useNetwork } from "@/context/NetworkContext";
import { formatNetwork } from "@/lib/wallet";
import type { NetworkId } from "@/lib/stellar-config";

/**
 * Resolves a wallet-reported network string or passphrase to a supported app NetworkId.
 */
export function resolveSupportedNetworkId(walletNetwork: string): NetworkId | null {
  const raw = walletNetwork.trim().toLowerCase();
  if (!raw) return null;

  if (raw.includes("future")) {
    return "futurenet";
  }

  if (raw.includes("sandbox") || raw.includes("standalone") || raw.includes("local")) {
    return "sandbox";
  }

  const formatted = formatNetwork(walletNetwork).trim().toLowerCase();
  if (formatted === "mainnet") {
    return "mainnet";
  }

  if (formatted === "testnet") {
    return "testnet";
  }

  return null;
}

export function WalletMismatchBanner() {
  const { session, connect, selectedWalletId } = useWallet();
  const { network, setNetworkId } = useNetwork();

  if (!session) return null;

  const walletNetworkLabel = formatNetwork(session.network);
  const targetNetworkId = resolveSupportedNetworkId(session.network);

  if (
    walletNetworkLabel.toLowerCase() === network.name.toLowerCase() ||
    (targetNetworkId !== null && targetNetworkId === network.id)
  ) {
    return null;
  }

  const handleSwitchAppNetwork = () => {
    if (targetNetworkId) {
      setNetworkId(targetNetworkId);
    }
  };

  const handleRecheckConnection = () => {
    const walletIdToCheck = selectedWalletId ?? session.walletId;
    if (walletIdToCheck) {
      void connect(walletIdToCheck);
    }
  };

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-4 border-b border-orange-400/30 bg-orange-400/10 px-6 py-2 text-sm text-orange-100"
    >
      <span className="flex flex-wrap items-center gap-2">
        <AlertTriangle size={16} className="shrink-0" aria-hidden="true" />
        <span>
          Wallet is on{" "}
          <strong
            data-testid="wallet-network-badge"
            className="inline-flex items-center rounded bg-orange-400/20 px-2 py-0.5 font-bold text-orange-50"
          >
            {walletNetworkLabel}
          </strong>
          ; app is using{" "}
          <strong
            data-testid="app-network-badge"
            className="inline-flex items-center rounded bg-orange-400/20 px-2 py-0.5 font-bold text-orange-50"
          >
            {network.name}
          </strong>
          . Transactions may fail.
        </span>
      </span>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={handleSwitchAppNetwork}
          disabled={!targetNetworkId}
          className="flex items-center gap-1.5 rounded border border-orange-300/40 bg-orange-400/15 px-3 py-1 text-xs font-semibold transition-colors hover:bg-orange-400/25 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowLeftRight size={13} aria-hidden="true" />
          Switch App to Wallet Network
        </button>
        <button
          type="button"
          onClick={handleRecheckConnection}
          className="flex items-center gap-1.5 rounded border border-orange-300/40 px-3 py-1 text-xs font-semibold transition-colors hover:bg-orange-400/20"
        >
          <RefreshCw size={13} aria-hidden="true" />
          Re-check Connection
        </button>
      </div>
    </div>
  );
}