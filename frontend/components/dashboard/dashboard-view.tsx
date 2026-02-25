"use client";

/**
 * components/dashboard/dashboard-view.tsx
 *
 * Changes from previous version:
 *  - Removed "Mocked wallet session" warning banner (no longer relevant).
 *  - wallet-chip now shows network badge alongside the public key.
 *  - formatNetwork() used so "PUBLIC" → "Mainnet", "TESTNET" → "Testnet".
 */

import React from "react";
import {
  getDashboardAnalytics,
  fetchDashboardData,
  type DashboardSnapshot,
} from "@/lib/dashboard";
import {
  shortenPublicKey,
  formatNetwork,
  isExpectedNetwork,
  type WalletSession,
} from "@/lib/wallet";
import IncomingStreams from "../IncomingStreams";
import {
  StreamCreationWizard,
  type StreamFormData,
} from "../stream-creation/StreamCreationWizard";
import { Button } from "../ui/Button";

interface DashboardViewProps {
  session: WalletSession;
  onDisconnect: () => void;
}

interface SidebarItem {
  id: string;
  label: string;
}

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
  { id: "streams", label: "Outgoing" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "activity", label: "Activity" },
  { id: "settings", label: "Settings" },
];

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
              <span>
                {isUnavailable ? metric.unavailableText : metric.detail}
              </span>
            </article>
          );
        })}
      </div>
    </section>
  );
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
        <span>{snapshot.outgoingStreams.length} total</span>
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
            {snapshot.outgoingStreams.map((stream) => (
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

// ── Main component ────────────────────────────────────────────────────────────
function safeLoadTemplates(): StreamTemplate[] {
  if (typeof window === "undefined") {
    return [];
  }

  const stored = window.localStorage.getItem(STREAM_TEMPLATES_STORAGE_KEY);
  if (!stored) {
    return [];
  }

  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is StreamTemplate => {
      return (
        typeof item?.id === "string" &&
        typeof item?.name === "string" &&
        typeof item?.createdAt === "string" &&
        typeof item?.updatedAt === "string" &&
        typeof item?.values === "object" &&
        typeof item.values?.recipient === "string" &&
        typeof item.values?.token === "string" &&
        typeof item.values?.totalAmount === "string" &&
        typeof item.values?.startsAt === "string" &&
        typeof item.values?.endsAt === "string" &&
        typeof item.values?.cadenceSeconds === "string" &&
        typeof item.values?.note === "string"
      );
    });
  } catch {
    return [];
  }
}

function persistTemplates(templates: StreamTemplate[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    STREAM_TEMPLATES_STORAGE_KEY,
    JSON.stringify(templates),
  );
}

function formatTemplateUpdatedAt(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function createTemplateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `template-${Date.now()}`;
}

export function DashboardView({ session, onDisconnect }: DashboardViewProps) {
  const [activeTab, setActiveTab] = React.useState("overview");
  const [streamForm, setStreamForm] = React.useState<StreamFormValues>(
    EMPTY_STREAM_FORM,
  );
  const [templates, setTemplates] = React.useState<StreamTemplate[]>([]);
  const [templatesHydrated, setTemplatesHydrated] = React.useState(false);
  const [templateNameInput, setTemplateNameInput] = React.useState("");
  const [editingTemplateId, setEditingTemplateId] = React.useState<
    string | null
  >(null);
  const [selectedTemplateId, setSelectedTemplateId] = React.useState<
    string | null
  >(null);
  const [streamFormMessage, setStreamFormMessage] =
    React.useState<StreamFormMessageState | null>(null);
  const stats = getMockDashboardStats(session.walletId);

  React.useEffect(() => {
    const loadedTemplates = safeLoadTemplates();
    setTemplates(loadedTemplates);
    setTemplatesHydrated(true);
  }, []);

  React.useEffect(() => {
    if (!templatesHydrated) {
      return;
    }
    persistTemplates(templates);
  }, [templates, templatesHydrated]);

  const updateStreamForm = (field: keyof StreamFormValues, value: string) => {
    setStreamForm((previous) => ({ ...previous, [field]: value }));
    setStreamFormMessage(null);
  };

  const requiredFieldsCompleted = [
    streamForm.recipient,
    streamForm.token,
    streamForm.totalAmount,
    streamForm.startsAt,
    streamForm.endsAt,
  ].filter((value) => value.trim().length > 0).length;

  const saveTemplateButtonLabel = editingTemplateId
    ? "Update Template"
    : "Save as Template";

  const isTemplateNameValid = templateNameInput.trim().length > 0;

  const handleTopUp = (streamId: string) => {
    const amount = prompt(`Enter amount to add to stream ${streamId}:`);
    if (amount && !Number.isNaN(parseFloat(amount)) && parseFloat(amount) > 0) {
      console.log(`Adding ${amount} funds to stream ${streamId}`);
      // TODO: Integrate with Soroban contract's top_up_stream function
      alert(`Successfully added ${amount} to stream ${streamId}`);
    }
  };

  const handleCreateStream = async (data: StreamFormData) => {
    console.log("Creating stream with data:", data);
    // TODO: Integrate with Soroban contract's create_stream function
    await new Promise((resolve) => setTimeout(resolve, 1500));
    alert(
      `Stream created successfully!\n\nRecipient: ${data.recipient}\nToken: ${data.token}\nAmount: ${data.amount}\nDuration: ${data.duration} ${data.durationUnit}`,
    );
    setShowWizard(false);
  const handleApplyTemplate = (templateId: string) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) {
      return;
    }

    setStreamForm({ ...template.values });
    setSelectedTemplateId(template.id);
    setStreamFormMessage({
      text: `Applied template "${template.name}". You can still adjust any field.`,
      tone: "success",
    });
  };

  const handleDeleteTemplate = (templateId: string) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) {
      return;
    }

    const shouldDelete = window.confirm(
      `Delete stream template "${template.name}"?`,
    );
    if (!shouldDelete) {
      return;
    }

    setTemplates((previous) => previous.filter((item) => item.id !== templateId));
    if (selectedTemplateId === templateId) {
      setSelectedTemplateId(null);
    }
    if (editingTemplateId === templateId) {
      setEditingTemplateId(null);
      setTemplateNameInput("");
    }
  };

  const handleSaveTemplate = () => {
    const cleanedName = templateNameInput.trim();
    if (!cleanedName) {
      setStreamFormMessage({
        text: "Template name is required.",
        tone: "error",
      });
      return;
    }

    const now = new Date().toISOString();

    if (editingTemplateId) {
      setTemplates((previous) =>
        previous.map((template) =>
          template.id === editingTemplateId
            ? {
                ...template,
                name: cleanedName,
                updatedAt: now,
                values: { ...streamForm },
              }
            : template,
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
      id: createTemplateId(),
      name: cleanedName,
      createdAt: now,
      updatedAt: now,
      values: { ...streamForm },
    };

    setTemplates((previous) => [newTemplate, ...previous]);
    setSelectedTemplateId(newTemplate.id);
    setTemplateNameInput("");
    setStreamFormMessage({
      text: `Template "${cleanedName}" saved.`,
      tone: "success",
    });
  };

  const handleEditTemplate = (templateId: string) => {
    const template = templates.find((item) => item.id === templateId);
    if (!template) {
      return;
    }

    setEditingTemplateId(template.id);
    setTemplateNameInput(template.name);
    setSelectedTemplateId(template.id);
    setStreamForm({ ...template.values });
    setStreamFormMessage({
      text: `Editing template "${template.name}". Save to overwrite it.`,
      tone: "info",
    });
  };

  const handleClearTemplateEditor = () => {
    setEditingTemplateId(null);
    setTemplateNameInput("");
    setStreamFormMessage(null);
  };

  const handleCreateStream = (event: React.FormEvent<HTMLFormElement>) => {
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

    alert(
      `Stream prepared for ${streamForm.recipient} with ${streamForm.totalAmount} ${streamForm.token}. You can still edit any field before final submission integration.`,
    );
    setStreamFormMessage({
      text: "Stream draft is ready for submission integration.",
      tone: "success",
    });
  };

  const handleResetStreamForm = () => {
    setStreamForm(EMPTY_STREAM_FORM);
    setSelectedTemplateId(null);
    setStreamFormMessage(null);
  };

  const renderContent = () => {
    if (activeTab === "incoming") {
      return (
        <div className="mt-8">
          <IncomingStreams />
        </div>
      );
    }

    if (activeTab === "overview") {
      if (!stats) {
      return <div className="mt-8"><IncomingStreams streams={stats?.incomingStreams || []} /></div>;
    }

    if (activeTab === "streams") {
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
                  Save recurring stream settings once, apply instantly, then
                  override before submitting.
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
                          <small>
                            Updated {formatTemplateUpdatedAt(template.updatedAt)}
                          </small>
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

              <form className="stream-form" onSubmit={handleCreateStream}>
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
                    onChange={(event) =>
                      updateStreamForm("recipient", event.target.value)
                    }
                    placeholder="G... or 0x..."
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
                      step="any"
                      value={streamForm.totalAmount}
                      onChange={(event) =>
                        updateStreamForm("totalAmount", event.target.value)
                      }
                      placeholder="1000"
                    />
                  </label>
                </div>

                <div className="stream-form__row">
                  <label>
                    Start Date & Time
                    <input
                      required
                      type="datetime-local"
                      value={streamForm.startsAt}
                      onChange={(event) =>
                        updateStreamForm("startsAt", event.target.value)
                      }
                    />
                  </label>

                  <label>
                    End Date & Time
                    <input
                      required
                      type="datetime-local"
                      value={streamForm.endsAt}
                      onChange={(event) =>
                        updateStreamForm("endsAt", event.target.value)
                      }
                    />
                  </label>
                </div>

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
                    placeholder="1"
                  />
                </label>

                <label>
                  Notes
                  <textarea
                    rows={3}
                    value={streamForm.note}
                    onChange={(event) => updateStreamForm("note", event.target.value)}
                    placeholder="Optional internal label or memo."
                  />
                </label>

                <div className="stream-form__actions">
                  <button type="submit" className="wallet-button">
                    Review Stream
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={handleResetStreamForm}
                  >
                    Clear Form
                  </button>
                </div>
              </form>
            </div>
          </section>
        </div>
      );
    }

    if (activeTab === "overview") {
      if (loading) {
        return (
          <div className="dashboard-loading-state mt-8">
            <div className="spinner"></div>
            <p>Fetching your stream data...</p>
          </div>
        );
      }

      if (error) {
        return (
          <div className="dashboard-error-state mt-8">
            <h3>Oops! Something went wrong</h3>
            <p>{error}</p>
            <Button onClick={() => window.location.reload()} className="mt-4">
              Retry
            </Button>
          </div>
        );
      }

      if (!stats || (stats.outgoingStreams.length === 0 && stats.recentActivity.length === 0)) {
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
            <div className="mt-6">
              <Button onClick={() => setShowWizard(true)} glow>
                Create Your First Stream
              </Button>
            </div>
          </section>
        );
      }
      return (
        <div className="dashboard-content-stack mt-8">
          {renderStats(stats)}
          {renderAnalytics(stats)}
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
            <h1>
              {SIDEBAR_ITEMS.find((item) => item.id === activeTab)?.label}
            </h1>
          </div>

          <div className="flex items-center gap-4">
            <Button onClick={() => setShowWizard(true)} glow>
              Create Stream
            </Button>

            {/* Wallet chip — shows wallet name, network, and shortened key */}
            <div className="wallet-chip" title={session.publicKey}>
              <span className="wallet-chip__name">{session.walletName}</span>
              <span
                className="wallet-chip__network"
                data-mainnet={networkLabel === "Mainnet" ? "true" : undefined}
                data-mismatch={!networkOk ? "true" : undefined}
              >
                {networkLabel}
              </span>
              <strong className="wallet-chip__key">
                {shortenPublicKey(session.publicKey)}
              </strong>
            </div>
          </div>
        </header>

        {renderContent()}

        <div className="dashboard-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onDisconnect}
          >
            Disconnect Wallet
          </button>
        </div>
      </section>

      {showWizard && (
        <StreamCreationWizard
          onClose={() => setShowWizard(false)}
          onSubmit={handleCreateStream}
        />
      )}
    </main>
  );
}
