"use client";

import { DashboardView } from "@/components/dashboard/dashboard-view";
import { WalletModal } from "@/components/wallet/WalletModal";
import { useWallet } from "@/context/wallet-context";
import { useState, useEffect } from "react";

export function WalletEntry() {
  const { status, session, isHydrated, disconnect } = useWallet();
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (isHydrated && status !== "connected") {
      setShowModal(true);
    } else if (status === "connected") {
      setShowModal(false);
    }
  }, [isHydrated, status]);

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

  return showModal ? (
    <WalletModal onClose={() => setShowModal(false)} />
  ) : null;
}
