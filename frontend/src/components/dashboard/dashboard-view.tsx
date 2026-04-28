"use client";

import React from "react";
import Link from "next/link";
import toast from "react-hot-toast";

/**
 * components/dashboard/dashboard-view.tsx
 *
 * Changes from previous version:
 *  - Removed "Mocked wallet session" warning banner (no longer relevant).
 *  - wallet-chip now shows network badge alongside the public key.
 *  - formatNetwork() used so "PUBLIC" → "Mainnet", "TESTNET" → "Testnet".
 */

import {
  getDashboardAnalytics,
  fetchDashboardData,
  type DashboardSnapshot,
  type Stream,
} from "@/lib/dashboard";
import {
  shortenPublicKey,
  formatNetwork,
  isExpectedNetwork,
  type WalletSession,
} from "@/lib/wallet";
import { isValidStellarPublicKey } from "@/lib/stellar";
import {
  createStream as sorobanCreateStream,
  topUpStream as sorobanTopUp,
  cancelStream as sorobanCancel,
  withdrawFromStream as sorobanWithdraw,
  toBaseUnits,
  toDurationSeconds,
  getTokenAddress,
  toSorobanErrorMessage,
} from "@/lib/soroban";
import IncomingStreams from "../IncomingStreams";
import { useStreamEvents } from "@/hooks/useStreamEvents";
import { SSEStatusIndicator } from "./SSEStatusIndicator";
import {
  StreamCreationWizard,
  type StreamFormData,
} from "../stream-creation/StreamCreationWizard";
import { TopUpModal } from "../stream-creation/TopUpModal";
import { CancelConfirmModal } from "../stream-creation/CancelConfirmModal";
import { StreamDetailsModal } from "./StreamDetailsModal";
import { Button } from "../ui/Button";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DashboardViewProps {
  session: WalletSession;
  onDisconnect: () => void;
}

interface SidebarItem {
  id: string;
  label: string;
}

// Modal state: null = closed
type ModalState =
  | null
  | { type: "topup"; stream: Stream }
  | { type: "cancel"; stream: Stream }
  | { type: "details"; stream: Stream };

interface StreamFormValues {
  recipient: string;
  token: string;
  totalAmount: string;
  startsAt: string;
  endsAt: string;
  cadenceSeconds: string;
  note: string;
}

interface StreamTemplate {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  values: StreamFormValues;
}

type StreamFormMessageTone = "info" | "success" | "error";

interface StreamFormMessageState {
  text: string;
  tone: StreamFormMessageTone;
}

const SIDEBAR_ITEMS: SidebarItem[] = [
  { id: "overview", label: "Overview" },
  { id: "incoming", label: "Incoming" },
  { id: "outgoing", label: "Outgoing" },
  { id: "paused", label: "Paused" },
  { id: "activity", label: "Activity" },
  { id: "settings", label: "Settings" },
];

// ─── Formatters ───────────────────────────────────────────────────────────────

const STREAM_TEMPLATES_STORAGE_KEY = "flowfi.stream.templates.v1";

const EMPTY_STREAM_FORM: StreamFormValues = {
  recipient: "",
  token: "USDC",
  totalAmount: "",
  startsAt: "",
  endsAt: "",
  cadenceSeconds: "1",
  note: "",
};

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
        <p className="text-2xl font-bold">{formatCurrency(snapshot.totalSent)}</p>
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
                {isUnavailable
                  ? "No data"
                  : formatAnalyticsValue(metric.value!, metric.format)}
              </h2>
              <span>{isUnavailable ? metric.unavailableText : metric.detail}</span>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function renderStreams(
  snapshot: DashboardSnapshot | null,
  onTopUp: (stream: Stream) => void,
  onCancel: (stream: Stream) => void,
  onShowDetails: (stream: Stream) => void,
) {
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
                  className="cursor-pointer hover:bg-white/5"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("button")) return;
                    onShowDetails(stream);
                  }}
                >
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
                    <div className="flex items-center justify-end gap-2">
                      {/^\d+$/.test(stream.id) ? (
                        <Link
                          href={`/app/streams/${stream.id}`}
                          className="secondary-button py-1 px-3 text-sm h-auto inline-flex items-center"
                        >
                          Details
                        </Link>
                      ) : null}
                  <button
                    type="button"
                    className="secondary-button py-1 px-3 text-sm h-auto"
                        onClick={() => onTopUp(stream)}
                  >
                    Add Funds
                  </button>
                      <button
                        type="button"
                        className="py-1 px-3 text-sm rounded-full border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors font-semibold"
                        onClick={() => onCancel(stream)}
                      >
                        Cancel
                      </button>
                    </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function renderRecentActivity(snapshot: DashboardSnapshot | null) {
  if (!snapshot) return null;
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
  const [showWizard, setShowWizard] = React.useState(false);
  const [modal, setModal] = React.useState<ModalState>(null);

  // SSE integration for real-time stream updates
  const { events: streamEvents, connected, reconnecting, error } = useStreamEvents({
    userPublicKeys: [session.publicKey],
    autoReconnect: true,
  });

  // Refresh dashboard when SSE events arrive
  React.useEffect(() => {
    if (streamEvents.length > 0) {
      const latestEvent = streamEvents[0];
      console.log('SSE event received:', latestEvent);
      // Refresh dashboard data on relevant events
      if (latestEvent.type === 'created' || latestEvent.type === 'topped_up' || 
          latestEvent.type === 'withdrawn' || latestEvent.type === 'cancelled' ||
          latestEvent.type === 'completed' || latestEvent.type === 'paused' ||
          latestEvent.type === 'resumed') {
        fetchDashboardData(session.publicKey)
          .then(setSnapshot)
          .catch(err => {
            setSnapshotError(err instanceof Error ? err.message : 'Failed to refresh dashboard');
          });
      }
    }
  }, [streamEvents, session.publicKey]);

  // --- Templates State (from upstream) ---
  const [streamForm, setStreamForm] = React.useState<StreamFormValues>(
    EMPTY_STREAM_FORM,
  );
  const [templates, setTemplates] = React.useState<StreamTemplate[]>([]);
  const [templatesHydrated, setTemplatesHydrated] = React.useState(false);
  const [templateNameInput, setTemplateNameInput] = React.useState("");
  const [editingTemplateId, setEditingTemplateId] = React.useState<string | null>(
    null,
  );
  const [selectedTemplateId, setSelectedTemplateId] = React.useState<
    string | null
  >(null);
  const [streamFormMessage, setStreamFormMessage] =
    React.useState<StreamFormMessageState | null>(null);

  // merged states
  const [withdrawingIncomingStreamId, setWithdrawingIncomingStreamId] =
    React.useState<string | null>(null);
  const [isFormSubmitting, setIsFormSubmitting] = React.useState(false);

  // --- Snapshot State (merged) ---
  const [snapshot, setSnapshot] = React.useState<DashboardSnapshot | null>(null);
  const [isSnapshotLoading, setIsSnapshotLoading] = React.useState(true);
  const [snapshotError, setSnapshotError] = React.useState<string | null>(null);

  // --- Helper Functions for missing logic ---
  const safeLoadTemplates = (): StreamTemplate[] => {
    try {
      if (typeof window === "undefined") return [];
      const stored = localStorage.getItem(STREAM_TEMPLATES_STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  };

  const persistTemplates = (items: StreamTemplate[]) => {
    if (typeof window === "undefined") return;
    localStorage.setItem(STREAM_TEMPLATES_STORAGE_KEY, JSON.stringify(items));
  };

  const formatTemplateUpdatedAt = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleDateString();
  };

  const isTemplateNameValid = templateNameInput.trim().length > 0;
  const saveTemplateButtonLabel = editingTemplateId
    ? "Update Template"
    : "Save Template";
  const requiredFieldsCompleted = Object.values(streamForm).filter(
    (v) => v.trim().length > 0,
  ).length;

  const handleClearTemplateEditor = () => {
    setTemplateNameInput("");
    setEditingTemplateId(null);
  };

  // --- Templates Effects & Handlers ---
  React.useEffect(() => {
    const loadedTemplates = safeLoadTemplates();
    setTemplates(loadedTemplates);
    setTemplatesHydrated(true);
  }, []);

  React.useEffect(() => {
    if (!templatesHydrated) return;
    persistTemplates(templates);
  }, [templates, templatesHydrated]);

  React.useEffect(() => {
    let cancelled = false;

    const loadSnapshot = async () => {
      setIsSnapshotLoading(true);
      setSnapshotError(null);

      try {
        const nextSnapshot = await fetchDashboardData(session.publicKey);
        if (!cancelled) setSnapshot(nextSnapshot);
      } catch (error) {
        if (!cancelled) {
          setSnapshot(null);
          setSnapshotError(
            error instanceof Error ? error.message : "Failed to fetch dashboard data.",
          );
        }
      } finally {
        if (!cancelled) setIsSnapshotLoading(false);
      }
    };

    void loadSnapshot();
    return () => {
      cancelled = true;
    };
  }, [session.publicKey]);

  const updateStreamForm = (field: keyof StreamFormValues, value: string) => {
    setStreamForm((previous) => ({ ...previous, [field]: value }));
    setStreamFormMessage(null);
  };

  const handleTopUp = (streamId: string) => {
    const amount = prompt(`Enter amount to add to stream ${streamId}:`);
    if (amount && !Number.isNaN(parseFloat(amount)) && parseFloat(amount) > 0) {
      console.log(`Adding ${amount} funds to stream ${streamId}`);
      // TODO: Integrate with Soroban contract's top_up_stream function
      alert(`Successfully added ${amount} to stream ${streamId}`);
    }
  };

  const handleApplyTemplate = (templateId: string) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;
    setStreamForm({ ...template.values });
    setSelectedTemplateId(template.id);
    setStreamFormMessage({
      text: `Applied template "${template.name}". You can still adjust any field.`,
      tone: "success",
    });
  };

  const handleSaveTemplate = () => {
    const cleanedName = templateNameInput.trim();
    if (!cleanedName) {
      setStreamFormMessage({ text: "Template name is required.", tone: "error" });
      return;
    }
    const now = new Date().toISOString();
    if (editingTemplateId) {
      setTemplates((prev) =>
        prev.map((t) =>
          t.id === editingTemplateId
            ? { ...t, name: cleanedName, updatedAt: now, values: { ...streamForm } }
            : t,
        ),
      );
      setStreamFormMessage({
        text: `Template "${cleanedName}" updated.`,
        tone: "success",
      });
      setSelectedTemplateId(editingTemplateId);
      setEditingTemplateId(null);
      setTemplateNameInput("");
      return;
    }
    const newTemplate: StreamTemplate = {
      id: `template-${Date.now()}`,
      name: cleanedName,
      createdAt: now,
      updatedAt: now,
      values: { ...streamForm },
    };
    setTemplates((prev) => [newTemplate, ...prev]);
    setSelectedTemplateId(newTemplate.id);
    setTemplateNameInput("");
    setStreamFormMessage({
      text: `Template "${cleanedName}" saved.`,
      tone: "success",
    });
  };

  const handleEditTemplate = (templateId: string) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;
    setEditingTemplateId(template.id);
    setTemplateNameInput(template.name);
    setSelectedTemplateId(template.id);
    setStreamForm({ ...template.values });
    setStreamFormMessage({
      text: `Editing template "${template.name}". Save to overwrite it.`,
      tone: "info",
    });
  };

  const handleDeleteTemplate = (templateId: string) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) return;
    if (!window.confirm(`Delete stream template "${template.name}"?`)) return;
    setTemplates((prev) => prev.filter((item) => item.id !== templateId));
    if (selectedTemplateId === templateId) setSelectedTemplateId(null);
    if (editingTemplateId === templateId) {
    setEditingTemplateId(null);
    setTemplateNameInput("");
    }
  };

  const handleResetStreamForm = () => {
    setStreamForm(EMPTY_STREAM_FORM);
    setSelectedTemplateId(null);
    setStreamFormMessage(null);
  };

  // ── Optimistic helpers ──────────────────────────────────────────────────────

  const removeStreamLocally = (streamId: string) => {
    setSnapshot((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        outgoingStreams: prev.outgoingStreams.map((s) =>
          s.id === streamId
            ? { ...s, status: "Cancelled", isActive: false }
            : s,
        ),
        activeStreamsCount: Math.max(0, prev.activeStreamsCount - 1),
      };
    });
  };

  const topUpStreamLocally = (streamId: string, amount: number) => {
    setSnapshot((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        outgoingStreams: prev.outgoingStreams.map((s) =>
          s.id === streamId ? { ...s, deposited: s.deposited + amount } : s,
        ),
      };
    });
  };

  const addStreamLocally = (data: StreamFormData) => {
    const newStream: Stream = {
      id: `stream-${Date.now()}`,
      date: new Date().toISOString().split("T")[0],
      recipient: shortenPublicKey(data.recipient),
      amount: parseFloat(data.amount),
      token: data.token,
      status: "Active",
      deposited: parseFloat(data.amount),
      withdrawn: 0,
      ratePerSecond: 0,
      lastUpdateTime: Math.floor(Date.now() / 1000),
      isActive: true,
    };
    setSnapshot((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        outgoingStreams: [newStream, ...prev.outgoingStreams],
        activeStreamsCount: prev.activeStreamsCount + 1,
      };
    });
  };

  // ── Contract handlers ───────────────────────────────────────────────────────

  const handleCreateStream = async (data: StreamFormData) => {
    const toastId = toast.loading("Creating stream…");
    try {
      const durationSecs = toDurationSeconds(data.duration, data.durationUnit);
      const amount = toBaseUnits(data.amount);
      const tokenAddress = getTokenAddress(data.token);

      await sorobanCreateStream(session, {
        recipient: data.recipient,
        tokenAddress,
        amount,
        durationSeconds: durationSecs,
      });

      addStreamLocally(data);
      setShowWizard(false);
      toast.success("Stream created successfully!", { id: toastId });
    } catch (err) {
      toast.error(toSorobanErrorMessage(err), { id: toastId });
      throw err;
    }
  };

  const handleTopUpConfirm = async (streamId: string, amountStr: string) => {
    const toastId = toast.loading("Topping up stream…");
    try {
      const amount = toBaseUnits(amountStr);
      await sorobanTopUp(session, {
        streamId: BigInt(streamId.replace(/\D/g, "") || "0"),
        amount,
      });

      topUpStreamLocally(streamId, parseFloat(amountStr));
      setModal(null);
      toast.success("Stream topped up successfully!", { id: toastId });
    } catch (err) {
      toast.error(toSorobanErrorMessage(err), { id: toastId });
      throw err;
    }
  };

  const handleCancelConfirm = async (streamId: string) => {
    const toastId = toast.loading("Cancelling stream…");
    try {
      await sorobanCancel(session, {
        streamId: BigInt(streamId.replace(/\D/g, "") || "0"),
      });

      removeStreamLocally(streamId);
      setModal(null);
      toast.success("Stream cancelled.", { id: toastId });
    } catch (err) {
      toast.error(toSorobanErrorMessage(err), { id: toastId });
      throw err;
    }
  };

  const handleIncomingWithdraw = async (stream: Stream) => {
    const toastId = toast.loading("Withdrawing stream funds…");
    setWithdrawingIncomingStreamId(stream.id);

    try {
      await sorobanWithdraw(session, {
        streamId: BigInt(stream.id.replace(/\D/g, "") || "0"),
      });

      const refreshed = await fetchDashboardData(session.publicKey);
      setSnapshot(refreshed);
      toast.success("Withdrawal successful!", { id: toastId });
    } catch (err) {
      toast.error(toSorobanErrorMessage(err), { id: toastId });
      throw err;
    } finally {
      setWithdrawingIncomingStreamId(null);
    }
  };

  const handleFormCreateStream = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    const hasRequiredFields =
      streamForm.recipient.trim() &&
      streamForm.token.trim() &&
      streamForm.totalAmount.trim() &&
      streamForm.startsAt.trim() &&
      streamForm.endsAt.trim();

    if (!hasRequiredFields) {
      setStreamFormMessage({
        text: "Complete all required fields before creating.",
        tone: "error",
      });
      return;
    }

    const recipient = streamForm.recipient.trim();
    if (!isValidStellarPublicKey(recipient)) {
      setStreamFormMessage({
        text: "Recipient must be a valid Stellar public key.",
        tone: "error",
      });
      return;
    }

    const startDate = new Date(streamForm.startsAt);
    const endDate = new Date(streamForm.endsAt);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      setStreamFormMessage({
        text: "Start and end times must be valid dates.",
        tone: "error",
      });
      return;
    }

    const durationSeconds = Math.floor(
      (endDate.getTime() - startDate.getTime()) / 1000,
    );
    if (durationSeconds <= 0) {
    setStreamFormMessage({
        text: "End time must be after start time.",
        tone: "error",
      });
      return;
    }

    setIsFormSubmitting(true);
    try {
      await handleCreateStream({
        recipient,
        token: streamForm.token.trim(),
        amount: streamForm.totalAmount.trim(),
        duration: String(durationSeconds),
        durationUnit: "seconds",
      });

      handleResetStreamForm();
      setStreamFormMessage({
        text: "Stream submitted to wallet and confirmed on-chain.",
      tone: "success",
    });
    } catch (err) {
      setStreamFormMessage({
        text: toSorobanErrorMessage(err),
        tone: "error",
      });
    } finally {
      setIsFormSubmitting(false);
    }
  };

  // ── Tab content ─────────────────────────────────────────────────────────────

  const renderContent = () => {
    if (isSnapshotLoading) {
      return (
        <div className="mt-8 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-32 rounded-2xl bg-white/5 animate-pulse" />
            ))}
          </div>
          <div className="h-64 rounded-2xl bg-white/5 animate-pulse" />
          <div className="h-96 rounded-2xl bg-white/5 animate-pulse" />
        </div>
      );
    }

    if (snapshotError) {
      return (
        <section className="dashboard-empty-state mt-8">
          <div className="p-8 rounded-2xl bg-red-500/10 border border-red-500/20 text-center">
            <h2 className="text-xl font-bold text-red-400">Dashboard unavailable</h2>
            <p className="text-slate-400 mt-2">{snapshotError}</p>
            <Button onClick={() => window.location.reload()} variant="ghost" className="mt-4">
              Try Again
            </Button>
          </div>
        </section>
      );
    }

    if (!snapshot || (snapshot.outgoingStreams.length === 0 && snapshot.incomingStreams.length === 0)) {
      return (
        <section className="dashboard-empty-state mt-8 flex flex-col items-center justify-center p-12 glass-card rounded-3xl border-slate-800">
          <div className="h-20 w-20 rounded-full bg-accent/10 flex items-center justify-center mb-6">
            <svg className="h-10 w-10 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold mb-2">Start your first stream</h2>
          <p className="text-slate-400 text-center max-w-md mb-8">
            You haven't created or received any payment streams yet. 
            Connect with others and start streaming tokens in real-time.
          </p>
          <Button onClick={() => setShowWizard(true)} glow size="lg">
            Create Stream
          </Button>
        </section>
      );
    }

    if (activeTab === "overview") {
      return (
        <div className="dashboard-content-stack mt-8">
          {renderStats(snapshot)}
          {renderAnalytics(snapshot)}
          {renderStreams(
            snapshot,
            (stream: Stream) => setModal({ type: "topup", stream }),
            (stream: Stream) => setModal({ type: "cancel", stream }),
            (stream: Stream) => setModal({ type: "details", stream }),
          )}
          {renderRecentActivity(snapshot)}
        </div>
      );
    }

    if (activeTab === "incoming") {
      return (
        <div className="mt-8">
          <IncomingStreams
            streams={snapshot.incomingStreams}
            onWithdraw={handleIncomingWithdraw}
            withdrawingStreamId={withdrawingIncomingStreamId}
          />
        </div>
      );
    }

    if (activeTab === "outgoing") {
      const activeOutgoing = snapshot.outgoingStreams.filter(s => s.status === 'Active');
      return (
        <div className="mt-8">
          {activeOutgoing.length > 0 ? (
            renderStreams(
              { ...snapshot, outgoingStreams: activeOutgoing },
              (stream: Stream) => setModal({ type: "topup", stream }),
              (stream: Stream) => setModal({ type: "cancel", stream }),
              (stream: Stream) => setModal({ type: "details", stream }),
            )
          ) : (
            <div className="glass-card p-12 rounded-3xl border-slate-800 text-center">
              <p className="text-slate-400">No active outgoing streams.</p>
              <Button onClick={() => setShowWizard(true)} variant="ghost" className="mt-4">
                Create One Now
              </Button>
            </div>
          )}
        </div>
      );
    }

    if (activeTab === "paused") {
      const pausedStreams = [
        ...snapshot.outgoingStreams.filter(s => s.status === 'Paused'),
        ...snapshot.incomingStreams.filter(s => s.status === 'Paused')
      ];
      return (
        <div className="mt-8">
          {pausedStreams.length > 0 ? (
            <div className="glass-card rounded-3xl border-slate-800 overflow-hidden">
               {/* Simplified list for paused streams */}
               <table className="dashboard-table w-full">
                 <thead>
                   <tr>
                     <th>Stream ID</th>
                     <th>Counterparty</th>
                     <th>Token</th>
                     <th>Status</th>
                   </tr>
                 </thead>
                 <tbody>
                   {pausedStreams.map(s => (
                     <tr key={s.id}>
                       <td>#{s.id}</td>
                       <td className="font-mono text-xs">{s.recipient}</td>
                       <td>{s.token}</td>
                       <td><span className="px-2 py-1 rounded-full bg-yellow-500/10 text-yellow-500 text-xs font-bold">Paused</span></td>
                     </tr>
                   ))}
                 </tbody>
               </table>
            </div>
          ) : (
            <div className="glass-card p-12 rounded-3xl border-slate-800 text-center text-slate-400">
              No paused streams found.
            </div>
          )}
        </div>
      );
    }

    if (activeTab === "activity") {
      return (
        <div className="mt-8">
          {renderRecentActivity(snapshot)}
        </div>
      );
    }

    if (activeTab === "settings") {
      return (
        <div className="dashboard-content-stack mt-8">
          <section className="dashboard-panel dashboard-panel--stream-builder">
            <div className="dashboard-panel__header">
              <h3>Create Stream</h3>
              <span>Save and reuse recurring configurations</span>
            </div>

            {streamFormMessage ? (
              <p className="stream-form-message" data-tone={streamFormMessage.tone}>
                {streamFormMessage.text}
              </p>
            ) : null}

            <div className="stream-template-layout">
              <div className="stream-template-manager">
                <h4>Template Library</h4>
                <p>
                  Save recurring stream settings once, apply instantly, then override
                  before submitting.
                </p>

                <div className="stream-template-editor">
                  <input
                    value={templateNameInput}
                    onChange={(event) => setTemplateNameInput(event.target.value)}
                    placeholder="e.g. Monthly Contributor Payroll"
                    aria-label="Template name"
                  />
                  <div className="stream-template-editor__actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={!isTemplateNameValid}
                      onClick={handleSaveTemplate}
                    >
                      {saveTemplateButtonLabel}
                    </button>
                    {editingTemplateId ? (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={handleClearTemplateEditor}
                      >
                        Stop Editing
                      </button>
                    ) : null}
                  </div>
                </div>

                {templates.length === 0 ? (
                  <div className="mini-empty-state">
                    <p>No templates yet. Save your first stream setup.</p>
                  </div>
                ) : (
                  <ul className="stream-template-list">
                    {templates.map((template) => (
                      <li
                        key={template.id}
                        className="stream-template-item"
                        data-active={
                          selectedTemplateId === template.id ? "true" : undefined
                        }
                      >
                        <div className="stream-template-item__meta">
                          <strong>{template.name}</strong>
                          <small>Updated {formatTemplateUpdatedAt(template.updatedAt)}</small>
                        </div>
                        <div className="stream-template-item__actions">
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => handleApplyTemplate(template.id)}
                          >
                            Apply
                          </button>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => handleEditTemplate(template.id)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="secondary-button secondary-button--danger"
                            onClick={() => handleDeleteTemplate(template.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <form className="stream-form" onSubmit={handleFormCreateStream}>
                <div className="stream-form__meta">
                  <div>
                    <h4>Stream Configuration</h4>
                    <p>{requiredFieldsCompleted} / 5 required fields completed</p>
                  </div>
                  <label className="stream-form__template-select">
                    Load template
                    <select
                      value={selectedTemplateId ?? ""}
                      onChange={(event) => {
                        const templateId = event.target.value;
                        if (!templateId) {
                          setSelectedTemplateId(null);
                          return;
                        }
                        handleApplyTemplate(templateId);
                      }}
                    >
                      <option value="">Select saved template</option>
                      {templates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label>
                  Recipient Address
                  <input
                    required
                    type="text"
                    value={streamForm.recipient}
                    onChange={(event) => updateStreamForm("recipient", event.target.value)}
                    placeholder="G..."
                  />
                </label>

                <div className="stream-form__row">
                  <label>
                    Token
                    <input
                      required
                      type="text"
                      value={streamForm.token}
                      onChange={(event) =>
                        updateStreamForm("token", event.target.value.toUpperCase())
                      }
                      placeholder="USDC"
                    />
                  </label>
                  <label>
                    Total Amount
                    <input
                      required
                      type="number"
                      min="0"
                      step="0.0000001"
                      value={streamForm.totalAmount}
                      onChange={(event) => updateStreamForm("totalAmount", event.target.value)}
                      placeholder="100"
                    />
                  </label>
                </div>

                <div className="stream-form__row">
                  <label>
                    Starts At
                    <input
                      required
                      type="datetime-local"
                      value={streamForm.startsAt}
                      onChange={(event) => updateStreamForm("startsAt", event.target.value)}
                    />
                  </label>
                  <label>
                    Ends At
                    <input
                      required
                      type="datetime-local"
                      value={streamForm.endsAt}
                      onChange={(event) => updateStreamForm("endsAt", event.target.value)}
                    />
                  </label>
                </div>

                <div className="stream-form__row">
                <label>
                  Cadence (seconds)
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={streamForm.cadenceSeconds}
                    onChange={(event) =>
                      updateStreamForm("cadenceSeconds", event.target.value)
                    }
                  />
                </label>
                </div>

                <label>
                  Note
                  <textarea
                    value={streamForm.note}
                    onChange={(event) => updateStreamForm("note", event.target.value)}
                    placeholder="Optional internal note for this stream configuration."
                  />
                </label>

                <div className="stream-form__actions">
                  <button
                    type="submit"
                    className="wallet-button"
                    disabled={isFormSubmitting}
                  >
                    {isFormSubmitting ? "Submitting..." : "Create Stream"}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={isFormSubmitting}
                    onClick={handleResetStreamForm}
                  >
                    Reset
                  </button>
                </div>
              </form>
            </div>
          </section>
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

  const networkLabel = formatNetwork(session.network);
  const networkOk = isExpectedNetwork(session.network);

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
            <h1>{SIDEBAR_ITEMS.find((item) => item.id === activeTab)?.label}</h1>
          </div>

          <div className="flex items-center gap-4">
            <SSEStatusIndicator 
              connected={connected} 
              reconnecting={reconnecting} 
              error={error} 
            />

            <Button onClick={() => setShowWizard(true)} glow>
              Create Stream
            </Button>

            <div className="wallet-chip" title={session.publicKey}>
              <span className="wallet-chip__name">{session.walletName}</span>
              <span
                className="wallet-chip__network"
                data-mainnet={networkLabel === "Mainnet" ? "true" : undefined}
                data-mismatch={!networkOk ? "true" : undefined}
              >
                {networkLabel}
              </span>
              <span className="wallet-chip__key">
                {shortenPublicKey(session.publicKey)}
              </span>
            </div>
          </div>
        </header>

        {renderContent()}

        <div className="dashboard-actions">
          <button type="button" className="secondary-button" onClick={onDisconnect}>
            Disconnect Wallet
          </button>
        </div>
      </section>

      {showWizard && (
        <StreamCreationWizard
          onClose={() => setShowWizard(false)}
          onSubmit={handleCreateStream}
          walletPublicKey={session.publicKey}
        />
      )}

      {modal?.type === "topup" && (
        <TopUpModal
          streamId={modal.stream.id}
          token={modal.stream.token}
          currentDeposited={modal.stream.deposited}
          onConfirm={handleTopUpConfirm}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.type === "cancel" && (
        <CancelConfirmModal
          streamId={modal.stream.id}
          recipient={modal.stream.recipient}
          token={modal.stream.token}
          deposited={modal.stream.deposited}
          withdrawn={modal.stream.withdrawn}
          onConfirm={handleCancelConfirm}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.type === "details" && (
        <StreamDetailsModal
          stream={modal.stream}
          onClose={() => setModal(null)}
          onCancelClick={() => setModal({ type: "cancel", stream: modal.stream })}
          onTopUpClick={() => setModal({ type: "topup", stream: modal.stream })}
        />
      )}
    </main>
  );
}
