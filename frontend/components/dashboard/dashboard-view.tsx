"use client";
import React from "react";

import {
  getMockDashboardStats,
  type DashboardSnapshot,
} from "@/lib/dashboard";
import { shortenPublicKey, type WalletSession } from "@/lib/wallet";
import IncomingStreams from "../IncomingStreams";

interface DashboardViewProps {
  session: WalletSession;
  onDisconnect: () => void;
}

interface SidebarItem {
  id: string;
  label: string;
}

const SIDEBAR_ITEMS: SidebarItem[] = [
  { id: "overview", label: "Overview" },
  { id: "incoming", label: "Incoming" },
  { id: "streams", label: "Outgoing" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "activity", label: "Activity" },
  { id: "settings", label: "Settings" },
];

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  }).format(value);
}

function formatActivityTime(timestamp: string): string {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function renderStats(snapshot: DashboardSnapshot) {
  const items = [
    {
      id: "total-sent",
      label: "Total Sent",
      value: formatCurrency(snapshot.totalSent),
      detail: "Lifetime outgoing amount",
    },
    {
      id: "total-received",
      label: "Total Received",
      value: formatCurrency(snapshot.totalReceived),
      detail: "Lifetime incoming amount",
    },
    {
      id: "tvl",
      label: "Total Value Locked",
      value: formatCurrency(snapshot.totalValueLocked),
      detail: "Funds currently locked in streams",
    },
    {
      id: "active-streams",
      label: "Active Streams",
      value: String(snapshot.activeStreamsCount),
      detail: "Streams currently live",
    },
  ] as const;

  return (
    <section className="dashboard-stats-grid" aria-label="Wallet stats">
      {items.map((item) => (
        <article key={item.id} className="dashboard-stat-card">
          <p>{item.label}</p>
          <h2>{item.value}</h2>
          <span>{item.detail}</span>
        </article>
      ))}
    </section>
  );
}

function renderStreams(
  snapshot: DashboardSnapshot,
  onTopUp: (id: string) => void,
) {
  return (
    <section className="dashboard-panel">
      <div className="dashboard-panel__header">
        <h3>My Active Streams</h3>
        <span>{snapshot.streams.length} total</span>
      </div>

      <div className="overflow-x-auto">
        <table className="dashboard-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Recipient</th>
              <th>Deposited</th>
              <th>Withdrawn</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.streams.map((stream) => (
              <tr key={stream.id}>
                <td>{stream.date}</td>
                <td>
                  <code className="text-xs">{stream.recipient}</code>
                </td>
                <td className="font-semibold text-accent">
                  {stream.deposited} {stream.token}
                </td>
                <td className="text-slate-400">
                  {stream.withdrawn} {stream.token}
                </td>
                <td className="text-right">
                  <button
                    type="button"
                    className="secondary-button py-1 px-3 text-sm h-auto"
                    onClick={() => onTopUp(stream.id)}
                  >
                    Add Funds
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function renderRecentActivity(snapshot: DashboardSnapshot) {
  return (
    <section className="dashboard-panel">
      <div className="dashboard-panel__header">
        <h3>Recent Activity</h3>
        <span>{snapshot.recentActivity.length} items</span>
      </div>

      {snapshot.recentActivity.length > 0 ? (
        <ul className="activity-list">
          {snapshot.recentActivity.map((activity) => {
            const amountPrefix = activity.direction === "received" ? "+" : "-";
            const amountClass =
              activity.direction === "received" ? "is-positive" : "is-negative";

            return (
              <li key={activity.id} className="activity-item">
                <div>
                  <strong>{activity.title}</strong>
                  <p>{activity.description}</p>
                  <small>{formatActivityTime(activity.timestamp)}</small>
                </div>
                <span className={amountClass}>
                  {amountPrefix}
                  {formatCurrency(activity.amount)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mini-empty-state">
          <p>No recent activity yet.</p>
        </div>
      )}
    </section>
  );
}

export function DashboardView({ session, onDisconnect }: DashboardViewProps) {
  const [activeTab, setActiveTab] = React.useState("overview");
  const stats = getMockDashboardStats(session.walletId);

  const handleTopUp = (streamId: string) => {
    const amount = prompt(`Enter amount to add to stream ${streamId}:`);
    if (amount && !Number.isNaN(parseFloat(amount)) && parseFloat(amount) > 0) {
      console.log(`Adding ${amount} funds to stream ${streamId}`);
      // TODO: Integrate with Soroban contract's top_up_stream function
      alert(`Successfully added ${amount} to stream ${streamId}`);
    }
  };

  const renderContent = () => {
    if (activeTab === "incoming") {
      return <div className="mt-8"><IncomingStreams /></div>;
    }

    if (activeTab === "overview") {
        if (!stats) {
            return (
                <section className="dashboard-empty-state">
                  <h2>No stream data yet</h2>
                  <p>
                    Your account is connected, but there are no active or historical
                    stream records available yet.
                  </p>
                  <ul>
                    <li>Create your first payment stream</li>
                    <li>Invite a recipient to start receiving funds</li>
                    <li>Check back once transactions are confirmed</li>
                  </ul>
                </section>
            );
        }
        return (
            <div className="dashboard-content-stack mt-8">
              {renderStats(stats)}
              {renderStreams(stats, handleTopUp)}
              {renderRecentActivity(stats)}
            </div>
        );
    }
    
    return (
        <div className="dashboard-empty-state mt-8">
            <h2>Under Construction</h2>
            <p>This tab is currently under development.</p>
        </div>
    );
  };

  return (
    <main className="dashboard-shell">
      <aside className="dashboard-sidebar">
        <div className="brand">FlowFi</div>
        <nav aria-label="Sidebar">
          {SIDEBAR_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="sidebar-item"
              data-active={activeTab === item.id ? "true" : undefined}
              aria-current={activeTab === item.id ? "page" : undefined}
              onClick={() => setActiveTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <p className="kicker">Dashboard</p>
            <h1>{SIDEBAR_ITEMS.find(item => item.id === activeTab)?.label}</h1>
          </div>

          <div className="wallet-chip">
            <span>{session.walletName}</span>
            <strong>{shortenPublicKey(session.publicKey)}</strong>
          </div>
        </header>

        {session.mocked ? (
          <p className="dashboard-note">
            Mocked wallet session is active while adapter integrations are in
            progress.
          </p>
        ) : null}

        {renderContent()}

        <div className="dashboard-actions">
          <button type="button" className="secondary-button" onClick={onDisconnect}>
            Disconnect Wallet
          </button>
        </div>
      </section>
    </main>
  );
}
