import type { WalletSession } from "@/lib/wallet";

interface DashboardSettingsProps {
  session: WalletSession;
  onDisconnect: () => void;
}

export function DashboardSettings({ session, onDisconnect }: DashboardSettingsProps) {
  return (
    <div className="dashboard-content-stack mt-8">
      <section className="dashboard-panel dashboard-panel--stream-builder">
        <div className="dashboard-panel__header">
          <h3>Create Stream</h3>
          <span>Save and reuse recurring configurations</span>
        </div>

        <div className="stream-template-manager">
          <h4>Template Library</h4>
          <p>
            Save recurring stream settings once, apply instantly, then
            override before submitting.
          </p>

          <div className="stream-template-editor">
            <input
              placeholder="e.g. Monthly Contributor Payroll"
              aria-label="Template name"
            />
            <div className="stream-template-editor__actions">
              <button className="secondary-button" disabled>
                Save Template
              </button>
            </div>
          </div>

          <div className="mini-empty-state">
            <p>No templates yet. Save your first stream setup.</p>
          </div>
        </div>
      </section>
    </div>
  );
}