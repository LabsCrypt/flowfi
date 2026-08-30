"use client";

import React, { useRef, useState, useCallback } from "react";
import Link from "next/link";
import { useVirtualizer } from "@tanstack/react-virtual";
import { BackendStreamEvent } from "@/lib/api-types";
import { formatAmount } from "@/utils/amount";
import TransactionTracker from "@/components/TransactionTracker";
import { Download, ExternalLink, Clock } from "lucide-react";
import { Button } from "../ui/Button";

const VIRTUALIZATION_THRESHOLD = 50;

interface ActivityHistoryProps {
  events: BackendStreamEvent[];
  isLoading?: boolean;
}

export const ActivityHistory: React.FC<ActivityHistoryProps> = ({
  events,
  isLoading,
}) => {
  const parentRef = useRef<HTMLDivElement>(null);
  const shouldVirtualize = events.length > VIRTUALIZATION_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 5,
    enabled: shouldVirtualize,
  });

  const [exportStatus, setExportStatus] = useState<"idle" | "exporting" | "complete">("idle");

  const exportToCSV = useCallback(() => {
    setExportStatus("exporting");
    const headers = [
      "Stream ID",
      "Event Type",
      "Amount",
      "Timestamp",
      "Tx Hash",
    ];
    const rows = events.map((event) => [
      event.streamId,
      event.eventType,
      event.amount ? formatAmount(BigInt(event.amount), 7) : "0",
      new Date(event.timestamp * 1000).toISOString(),
      event.transactionHash || "",
    ]);

    const csvContent = [headers, ...rows].map((e) => e.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute(
      "download",
      `flowfi_activity_${new Date().getTime()}.csv`,
    );
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setExportStatus("complete");
    // Reset after screen readers have had time to announce
    setTimeout(() => setExportStatus("idle"), 3000);
  }, [events]);

  const renderEventMessage = (event: BackendStreamEvent): React.ReactNode => {
    const amount = event.amount ? formatAmount(BigInt(event.amount), 7) : "0";
    const link = (
      <Link
        href={`/streams/${event.streamId}`}
        className="text-accent hover:underline font-mono"
      >
        #{event.streamId}
      </Link>
    );

    switch (event.eventType) {
      case "CREATED":
        return <>New stream created ({link})</>;
      case "TOPPED_UP":
        return (
          <>
            Topped up Stream {link} with {amount} tokens
          </>
        );
      case "WITHDRAWN":
        return (
          <>
            Withdrew {amount} tokens from Stream {link}
          </>
        );
      case "CANCELLED":
        return <>Stream {link} was cancelled</>;
      case "COMPLETED":
        return <>Stream {link} was completed</>;
      case "PAUSED":
        return <>Stream {link} was paused</>;
      case "RESUMED":
        return <>Stream {link} was resumed</>;
      case "FEE_COLLECTED": {
        return (
          <>
            Fee of {amount} collected on Stream {link}
          </>
        );
      }
      case "FEE_CONFIG_UPDATED": {
        const metadata = event.metadata ? JSON.parse(event.metadata) : {};
        const oldRate = (metadata.old_fee_rate_bps ?? 0) / 100;
        const newRate = (metadata.new_fee_rate_bps ?? 0) / 100;
        return <>Fee configuration updated: {oldRate}% → {newRate}%</>;
      }
      case "ADMIN_TRANSFERRED": {
        const metadata = event.metadata ? JSON.parse(event.metadata) : {};
        const newAdmin = metadata.new_admin ?? null;
        return (
          <>
            {newAdmin ? `Admin transferred to ${newAdmin}` : 'Admin transferred'}
          </>
        );
      }
      default:
        return <>Event on Stream {link}</>;
    }
  };

  if (isLoading && events.length === 0) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="animate-pulse p-4 bg-white/5 border border-glass-border rounded-xl"
          >
            <div className="h-4 bg-gray-700 rounded w-3/4 mb-2"></div>
            <div className="h-3 bg-gray-700 rounded w-1/2"></div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Visually hidden live region for screen readers to announce export status */}
      <div aria-live="polite" className="sr-only">
        {exportStatus === "exporting" && "Exporting activity to CSV…"}
        {exportStatus === "complete" && "Export complete."}
      </div>

      <div className="flex justify-end">
        <Button
          onClick={exportToCSV}
          variant="outline"
          size="sm"
          className="flex items-center gap-2"
          disabled={events.length === 0}
          aria-busy={exportStatus === "exporting"}
        >
          <Download className="h-4 w-4" /> Export CSV
        </Button>
      </div>

      {shouldVirtualize ? (
        <div
          ref={parentRef}
          role="list"
          aria-label="Activity timeline"
          className="relative h-[600px] overflow-auto before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-slate-700 before:to-transparent"
        >
          <div
            style={{ height: virtualizer.getTotalSize() }}
            className="relative w-full"
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const event = events[virtualRow.index];
              if (!event) return null;
              return (
                <div
                  key={`${event.id}-${virtualRow.index}`}
                  ref={virtualizer.measureElement}
                  data-index={virtualRow.index}
                  role="listitem"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group mb-4"
                >
                  {/* Dot */}
                  <div className="flex items-center justify-center w-10 h-10 rounded-full border border-slate-700 bg-slate-900 text-accent shadow shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2">
                    <Clock className="h-5 w-5" />
                  </div>
                  {/* Content Card */}
                  <div className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] p-4 bg-white/5 border border-glass-border rounded-xl hover:bg-white/10 transition-colors shadow-xl">
                    <div className="flex flex-col sm:flex-row justify-between items-start mb-2 gap-2">
                      <div>
                        <p className="text-white font-medium text-sm sm:text-base">
                          {renderEventMessage(event)}
                        </p>
                        <time className="text-xs text-slate-400 flex items-center gap-1 mt-1">
                          {new Date(event.timestamp * 1000).toLocaleString()}
                        </time>
                      </div>
                      <span className="text-[10px] uppercase tracking-wider px-2 py-1 rounded bg-accent/10 text-accent font-bold border border-accent/20">
                        {event.eventType}
                      </span>
                    </div>

                    {event.transactionHash && (
                      <div className="mt-4 pt-4 border-t border-white/5 flex items-center justify-between">
                        <TransactionTracker
                          status="confirmed"
                          action="withdraw"
                          txHash={event.transactionHash}
                          streamId={event.streamId.toString()}
                        />
                        <a
                          href={`https://stellar.expert/explorer/testnet/tx/${event.transactionHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-slate-500 hover:text-white transition-colors"
                          title="View on Explorer"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div role="list" aria-label="Activity timeline" className="relative space-y-4 before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-slate-700 before:to-transparent">
          {events.map((event, index) => (
            <div
              key={`${event.id}-${index}`}
              role="listitem"
              className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group"
            >
              {/* Dot */}
              <div className="flex items-center justify-center w-10 h-10 rounded-full border border-slate-700 bg-slate-900 text-accent shadow shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2">
                <Clock className="h-5 w-5" />
              </div>
              {/* Content Card */}
              <div className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] p-4 bg-white/5 border border-glass-border rounded-xl hover:bg-white/10 transition-colors shadow-xl">
                <div className="flex flex-col sm:flex-row justify-between items-start mb-2 gap-2">
                  <div>
                    <p className="text-white font-medium text-sm sm:text-base">
                      {renderEventMessage(event)}
                    </p>
                    <time className="text-xs text-slate-400 flex items-center gap-1 mt-1">
                      {new Date(event.timestamp * 1000).toLocaleString()}
                    </time>
                  </div>
                  <span className="text-[10px] uppercase tracking-wider px-2 py-1 rounded bg-accent/10 text-accent font-bold border border-accent/20">
                    {event.eventType}
                  </span>
                </div>

                {event.transactionHash && (
                  <div className="mt-4 pt-4 border-t border-white/5 flex items-center justify-between">
                    <TransactionTracker
                      status="confirmed"
                      action="withdraw"
                      txHash={event.transactionHash}
                      streamId={event.streamId.toString()}
                    />
                    <a
                      href={`https://stellar.expert/explorer/testnet/tx/${event.transactionHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-slate-500 hover:text-white transition-colors"
                      title="View on Explorer"
                    >
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {events.length === 0 && !isLoading && (
        <div className="text-center py-12 text-slate-400 bg-white/5 rounded-xl border border-dashed border-slate-700">
          No activity found for this filter.
        </div>
      )}
    </div>
  );
};
