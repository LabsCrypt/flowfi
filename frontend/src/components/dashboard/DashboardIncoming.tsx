import IncomingStreams from "../IncomingStreams";
import type { Stream } from "@/lib/dashboard";
import { EmptyState } from "./dashboard-view";
import { InboxIcon } from "./dashboard-view";

interface DashboardIncomingProps {
  incomingStreams: Stream[];
  onWithdraw: (stream: Stream) => Promise<void>;
  withdrawingStreamId: string | null;
}

export function DashboardIncoming({
  incomingStreams,
  onWithdraw,
  withdrawingStreamId,
}: DashboardIncomingProps) {
  if (incomingStreams.length === 0) {
    return (
      <EmptyState
        icon={<InboxIcon />}
        title="No incoming streams yet"
        description="No streams are sending you funds yet. Share your wallet address with a sender to receive streaming payments."
      />
    );
  }
  return (
    <div className="mt-8">
      <IncomingStreams
        streams={incomingStreams}
        onWithdraw={onWithdraw}
        withdrawingStreamId={withdrawingStreamId}
      />
    </div>
  );
}