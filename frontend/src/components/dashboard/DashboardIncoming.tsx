import IncomingStreams from "../IncomingStreams";
import type { Stream } from "@/lib/dashboard";
import { EmptyState } from "./dashboard-view";
import { InboxIcon } from "./dashboard-view";
import { useState } from "react";
import { BatchClaimDrawer } from "./BatchClaimDrawer";

interface DashboardIncomingProps {
  incomingStreams: Stream[];
  onWithdraw: (stream: Stream) => Promise<void>;
  withdrawingStreamId: string | null;
  onBatchClaimSuccess?: () => Promise<void> | void;
}

export function DashboardIncoming({
  incomingStreams,
  onWithdraw,
  withdrawingStreamId,
  onBatchClaimSuccess,
}: DashboardIncomingProps) {
  const [showBatchClaim, setShowBatchClaim] = useState(false);
  const claimableCount = incomingStreams.filter((stream) => stream.isActive && stream.status === "Active" && stream.deposited > stream.withdrawn).length;
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
      {claimableCount >= 2 && <button type="button" onClick={() => setShowBatchClaim(true)} className="mb-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white">Claim all available</button>}
      <IncomingStreams
        streams={incomingStreams}
        onWithdraw={onWithdraw}
        withdrawingStreamId={withdrawingStreamId}
      />
      {showBatchClaim && <BatchClaimDrawer streams={incomingStreams} onClose={() => setShowBatchClaim(false)} onSuccess={onBatchClaimSuccess ?? (() => undefined)} />}
    </div>
  );
}