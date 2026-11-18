import type { Stream } from "@/lib/dashboard";

interface DashboardPausedProps {
  outgoingStreams: Stream[];
  incomingStreams: Stream[];
}

export function DashboardPaused({
  outgoingStreams,
  incomingStreams,
}: DashboardPausedProps) {
  const pausedStreams = [
    ...outgoingStreams.filter((s) => s.status === "Paused"),
    ...incomingStreams.filter((s) => s.status === "Paused"),
  ];

  if (pausedStreams.length === 0) {
    return (
      <div className="glass-card p-12 rounded-3xl border-slate-800 text-center text-slate-400 mt-8">
        No paused streams found.
      </div>
    );
  }
  return (
    <div className="mt-8 glass-card rounded-3xl border-slate-800 overflow-hidden">
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
          {pausedStreams.map((s) => (
            <tr key={s.id}>
              <td>#{s.id}</td>
              <td className="font-mono text-xs">{s.recipient}</td>
              <td>{s.token}</td>
              <td>
                <span className="px-2 py-1 rounded-full bg-yellow-500/10 text-yellow-500 text-xs font-bold">
                  Paused
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}