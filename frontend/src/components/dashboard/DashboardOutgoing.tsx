import { EmptyState } from "./dashboard-view";
import { BoltIcon } from "./dashboard-view";
import { Button } from "@/components/ui/Button";
import type { Stream } from "@/lib/dashboard";

interface DashboardOutgoingProps {
  outgoingStreams: Stream[];
  onTopUp: (stream: Stream) => void;
  onCancel: (stream: Stream) => void;
  onShowDetails: (stream: Stream) => void;
  setShowWizard: () => void;
}

export function DashboardOutgoing({
  outgoingStreams,
  onTopUp,
  onCancel,
  onShowDetails,
  setShowWizard,
}: DashboardOutgoingProps) {
  const activeOutgoing = outgoingStreams.filter((s) => s.status === "Active");

  if (activeOutgoing.length === 0) {
    return (
      <EmptyState
        icon={<BoltIcon />}
        title="No active outgoing streams"
        description="You don't have any active outgoing payment streams. Create one to start streaming tokens to a recipient."
        action={
          <Button onClick={setShowWizard} glow>
            Create a Stream
          </Button>
        }
      />
    );
  }

  return (
    <div className="mt-8">
      <section className="dashboard-panel">
        <div className="dashboard-panel__header">
          <h3>My Active Streams</h3>
          <span>{activeOutgoing.length} total</span>
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
              {activeOutgoing.map((stream) => (
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
                      <Button
                        className="secondary-button py-1 px-3 text-sm h-auto inline-flex items-center"
                      >
                        Details
                      </Button>
                      <Button
                        type="button"
                        className="secondary-button py-1 px-3 text-sm h-auto"
                        onClick={() => onTopUp(stream)}
                      >
                        Add Funds
                      </Button>
                      <Button
                        type="button"
                        className="py-1 px-3 text-sm rounded-full border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors font-semibold"
                        onClick={() => onCancel(stream)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}