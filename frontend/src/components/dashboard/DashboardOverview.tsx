"use client";

import * as React from "react";
import type { DashboardSnapshot } from "@/lib/dashboard";
import { fetchDashboardData, dashboardQueryKey } from "@/lib/dashboard";
import { EmptyState } from "./dashboard-view";
import { ActivityIcon } from "./dashboard-view";
import { Button } from "@/components/ui/Button";
import type { QueryClient } from "@tanstack/react-query";
import type { WalletSession } from "@/lib/wallet";

function renderStats(snapshot: DashboardSnapshot | null) {
  if (!snapshot) return null;
  return (
    <div className="dashboard-stats-grid">
      <div className="dashboard-panel">
        <h3>Total Sent</h3>
        <p className="text-2xl font-bold">
          {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(snapshot.totalSent)}
        </p>
      </div>
      <div className="dashboard-panel">
        <h3>Total Received</h3>
        <p className="text-2xl font-bold">
          {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(snapshot.totalReceived)}
        </p>
      </div>
      <div className="dashboard-panel">
        <h3>Total Value Locked</h3>
        <p className="text-2xl font-bold">
          {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(snapshot.totalValueLocked)}
        </p>
      </div>
    </div>
  );
}

function renderRecentActivity(
  snapshot: DashboardSnapshot | null,
  onCreateStream: () => void,
) {
  if (!snapshot) return null;

  if (snapshot.recentActivity.length === 0) {
    return (
      <EmptyState
        icon={<ActivityIcon />}
        title="No stream activity yet"
        description="Transactions will appear here once you start creating or receiving payment streams."
        action={
          <Button onClick={onCreateStream} variant="ghost">
            Create a Stream
          </Button>
        }
      />
    );
  }

  return (
    <section className="dashboard-panel">
      <div className="dashboard-panel__header">
        <h3>Recent Activity</h3>
        <span>{snapshot.recentActivity.length} items</span>
      </div>
      <ul className="activity-list">
        {snapshot.recentActivity.map((activity) => {
          const amountPrefix = activity.direction === "received" ? "+" : "-";
          const amountClass = activity.direction === "received" ? "is-positive" : "is-negative";
          return (
            <li key={activity.id} className="activity-item">
              <div>
                <strong>{activity.title}</strong>
                <p>{activity.description}</p>
                <small>{new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(activity.timestamp))}</small>
              </div>
              <span className={amountClass}>
                {amountPrefix}
                {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(activity.amount)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface DashboardOverviewProps {
  snapshot: DashboardSnapshot | null;
  isSnapshotLoading: boolean;
  snapshotError: string | null;
  session: WalletSession;
  onDisconnect: () => void;
  setShowWizard: () => void;
  queryClient: QueryClient;
}

export function DashboardOverview({
  snapshot,
  isSnapshotLoading,
  snapshotError,
  session,
  onDisconnect,
  setShowWizard,
  queryClient,
}: DashboardOverviewProps) {
  React.useEffect(() => {
    fetchDashboardData(session.publicKey)
      .then((next: DashboardSnapshot) => {
        queryClient.setQueryData(dashboardQueryKey(session.publicKey), next);
      })
      .catch((err) => {
        queryClient.setQueryData(dashboardQueryKey(session.publicKey), null);
      });
  }, [session.publicKey, queryClient]);

  return (
    <div className="dashboard-content-stack mt-8">
      {renderStats(snapshot)}
      {renderRecentActivity(snapshot, () => setShowWizard())}
    </div>
  );
}