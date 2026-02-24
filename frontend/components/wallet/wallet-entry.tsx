"use client";

import { DashboardView } from "@/components/dashboard/dashboard-view";
import { WalletSelectionModal } from "@/components/wallet/wallet-selection-modal";
import { useWallet } from "@/context/wallet-context";
import { useEffect } from "react";

export function WalletEntry() {
  const { status, session, isHydrated, disconnect } = useWallet();

  if (!isHydrated) {
    return (
      <main className="app-shell">
        <section className="wallet-panel wallet-panel--loading">
          <div className="loading-pulse" />
          <h1>Loading wallet session...</h1>
          <p className="subtitle">
            Checking your previous connection before loading FlowFi.
          </p>
        </section>
      </main>
    );
  }

  if (status === "connected" && session) {
    return <DashboardView session={session} onDisconnect={disconnect} />;
  }

  return (
    <WalletSelectionModal
      isOpen={status !== "connected"}
      onClose={undefined}
    />
  );
}
