"use client";

import React from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";

const DashboardSettingsDynamic = dynamic(
 () => import("./DashboardSettings").then((m) => m.DashboardSettings),
 { ssr: false },
);

// ─── Types ────────────────────────────────────────────────────────────────────

interface DashboardViewProps {
 session: WalletSession;
 onDisconnect: () => void;
}

type ModalState =
 | null
 | { type: "topup"; stream: Stream }
 | { type: "cancel"; stream: Stream }
 | { type: "details"; stream: Stream };

// ─── Skeleton & Empty State Components ───────────────────────────────────────

/** Shimmer card used as a placeholder while data loads */
function SkeletonCard({ className = "" }: { className?: string }) {
 return (
 <div
 className={`relative overflow-hidden rounded-2xl ${className}`}
 aria-hidden="true"
 >
 {/* shimmer sweep */}
 <div className="absolute inset-0 -translate-x-full motion-reduce:animate-none bg-gradient-to-r from-transparent via-white/10 to-transparent" />
 </div>
 );
}

/** Three stat cards + one table skeleton rendered while the API call is in-flight */
function DashboardSkeleton() {
 return (
 <div
 className="mt-8 space-y-6"
 aria-label="Loading dashboard…"
 role="status"
 >
 {/* stat cards */}
 <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
 <SkeletonCard className="h-32" />
 <SkeletonCard className="h-32" />
 <SkeletonCard className="h-32" />
 </div>
 {/* analytics strip */}
 <SkeletonCard className="h-40" />
 {/* streams table */}
 <SkeletonCard className="h-72" />
 {/* activity list */}
 <SkeletonCard className="h-48" />
 </div>
 );
}

/** Generic empty state with an optional CTA */
export function EmptyState({
 icon,
 title,
 description,
 action,
}: {
 icon: React.ReactNode;
 title: string;
 description: string;
 action?: React.ReactNode;
}) {
 return (
 <section className="flex flex-col items-center justify-center p-12 glass-card rounded-3xl border-slate-800 text-center mt-8">
 <div className="h-20 w-20 rounded-full bg-accent/10 flex items-center justify-center mb-6">
 {icon}
 </div>
 <h2 className="text-2xl font-bold mb-2">{title}</h2>
 <p className="text-slate-400 max-w-md mb-8">{description}</p>
 {action}
 </section>
 );
}

/** Shown when the API call to /v1/streams fails */
function ErrorState({
 message,
 onRetry,
}: {
 message: string;
 onRetry: () => void;
}) {
 return (
 <section className="mt-8">
 <div className="p-8 rounded-2xl bg-red-500/10 border border-red-500/20 text-center">
 <div className="h-16 w-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
 <svg
 className="h-8 w-8 text-red-400"
 fill="none"
 stroke="currentColor"
 viewBox="0 0 24 24"
 >
 <path
 strokeLinecap="round"
 strokeLinejoin="round"
 strokeWidth="2"
 d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
 />
 </svg>
 </div>
 <h2 className="text-xl font-bold text-red-400">
 Failed to load streams
 </h2>
 <p className="text-slate-400 mt-2 mb-6">{message}</p>
 <Button onClick={onRetry} variant="ghost">
 Retry
 </Button>
 </div>
 </section>
 );
}

// ─── Icon helpers ─────────────────────────────────────────────────────────────

export function BoltIcon() {
 return (
 <svg
 className="h-10 w-10 text-accent"
 fill="none"
 stroke="currentColor"
 viewBox="0 0 24 24"
 >
 <path
 strokeLinecap="round"
 strokeLinejoin="round"
 strokeWidth="2"
 d="M13 10V3L4 14h7v7l9-11h-7z"
 />
 </svg>
 );
}

export function InboxIcon() {
 return (
 <svg
 className="h-10 w-10 text-accent"
 fill="none"
 stroke="currentColor"
 viewBox="0 0 24 24"
 >
 <path
 strokeLinecap="round"
 strokeLinejoin="round"
 strokeWidth="2"
 d="M20 13V7a2 2 0 00-2-2H6a2 2 0 00-2 2v6m16 0l-2 4H6l-2-4m16 0H4"
 />
 </svg>
 );
}

export function ActivityIcon() {
 return (
 <svg
 className="h-10 w-10 text-accent"
 fill="none"
 stroke="currentColor"
 viewBox="0 0 24 24"
 >
 <path
 strokeLinecap="round"
 strokeLinejoin="round"
 strokeWidth="2"
 d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
 />
 </svg>
 );
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatCurrency(value: number): string {
 return new Intl.NumberFormat("en-US", {
 style: "currency",
 currency: "USD",
 maximumFractionDigits: value >= 1000 ? 0 : 2,
 }).format(value);
}

function formatAnalyticsValue(
 value: number,
 format: "currency" | "percent",
): string {
 if (format === "currency") return formatCurrency(value);
 return new Intl.NumberFormat("en-US", {
 style: "percent",
 maximumFractionDigits: 1,
 }).format(value);
}

function formatActivityTime(timestamp: string): string {
 const date = new Date(timestamp);
 if (Number.isNaN(date.getTime())) return timestamp;
 return new Intl.DateTimeFormat("en-US", {
 dateStyle: "medium",
 timeStyle: "short",
 }).format(date);
}

function renderStats(snapshot: DashboardSnapshot | null) {
 if (!snapshot) return null;
 return (
 <div className="dashboard-stats-grid">
 <div className="dashboard-panel">
 <h3>Total Sent</h3>
 <p className="text-2xl font-bold">
 {formatCurrency(snapshot.totalSent)}
 </p>
 </div>
 <div className="dashboard-panel">
 <h3>Total Received</h3>
 <p className="text-2xl font-bold">
 {formatCurrency(snapshot.totalReceived)}
 </p>
 </div>
 <div className="dashboard-panel">
 <h3>Total Value Locked</h3>
 <p className="text-2xl font-bold">
 {formatCurrency(snapshot.totalValueLocked)}
 </p>
 </div>
 </div>
 );
}

function renderAnalytics(snapshot: DashboardSnapshot | null) {
 const metrics = getDashboardAnalytics(snapshot);
 return (
 <section
 className="dashboard-analytics-section"
 aria-label="Analytics overview"
 >
 <div className="dashboard-panel__header">
 <h3>Analytics Overview</h3>
 <span>Computed from wallet activity</span>
 </div>
 <div className="dashboard-analytics-grid">
 {metrics.map((metric) => {
 const isUnavailable = metric.value === null;
 return (
 <article
 key={metric.id}
 className="dashboard-analytics-card"
 data-unavailable={isUnavailable ? "true" : undefined}
 >
 <p>{metric.label}</p>
 <h2>
 {isUnavailable ? "No data" : formatAnalyticsValue(metric.value!, metric.format)}
 </h2>
 <span>
 {isUnavailable ? "No data" : metric.detail}
 </span>
 </article>
 );
 })}
 </div>
 </section>
 );
}

const StreamsTable = React.memo(function StreamsTable({
 snapshot,
 onTopUp,
 onCancel,
 onShowDetails,
 selectedStreamId = null,
}: {
 snapshot: DashboardSnapshot | null;
 onTopUp: (stream: Stream) => void;
 onCancel: (stream: Stream) => void;
 onShowDetails: (stream: Stream) => void;
 selectedStreamId?: string | null;
}) {
 if (!snapshot) return null;
 return (
 <section className="dashboard-panel">
 <div className="dashboard-panel__header">
 <h3>My Active Streams</h3>
 <span>
 {snapshot.outgoingStreams.filter((s) => s.status === "Active").length}{" "}
 total
 </span>
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
 {snapshot.outgoingStreams
 .filter((s) => s.status === "Active")
 .map((stream) => (
 <tr
 key={stream.id}
 data-stream-id={stream.id}
 aria-selected={selectedStreamId === stream.id}
 className={`cursor-pointer hover:bg-white/5 ${
 selectedStreamId === stream.id
 ? "bg-accent/10 ring-1 ring-inset ring-accent/40"
 : ""
 }`}
 >
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </section>
 );
});
