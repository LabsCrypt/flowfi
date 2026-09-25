"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { useWallet } from "@/context/wallet-context";
import { useNetwork } from "@/context/NetworkContext";
import { formatNetwork } from "@/lib/wallet";

export function WalletMismatchBanner() {
  const { session, connect, selectedWalletId } = useWallet(); const { network } = useNetwork();
  if (!session || formatNetwork(session.network).toLowerCase() === network.name.toLowerCase()) return null;
  return <div role="alert" className="flex items-center justify-between gap-4 border-b border-orange-400/30 bg-orange-400/10 px-6 py-2 text-sm text-orange-100"><span className="flex items-center gap-2"><AlertTriangle size={16} />Wallet is on {formatNetwork(session.network)}; app is using {network.name}. Transactions may fail.</span><button onClick={() => { if (selectedWalletId) void connect(selectedWalletId); }} className="flex shrink-0 items-center gap-2 rounded border border-orange-300/40 px-3 py-1 text-xs font-semibold"><RefreshCw size={13} />Reconnect wallet</button></div>;
}