"use client";

import React from "react";
import { BackendStreamEvent } from "@/lib/api-types";
import { fromStroops } from "@/utils/amount";
import TransactionTracker from "@/components/TransactionTracker";
import { Download, ExternalLink, Clock } from "lucide-react";
import { Button } from "../ui/Button";

interface ActivityHistoryProps {
  events: BackendStreamEvent[];
  isLoading?: boolean;
}

export const ActivityHistory: React.FC<ActivityHistoryProps> = ({
  events,
  isLoading,
}) => {
  const exportToCSV = () => {
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
      event.amount ? fromStroops(BigInt(event.amount), 7) : "0",
      new Date(event.timestamp * 1000).toISOString(),
      event.txHash || "",
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
  };

  const formatEventMessage = (event: BackendStreamEvent) => {
    const amount = event.amount ? fromStroops(BigInt(event.amount), 7) : "0";
    const streamId = event.streamId;

    switch (event.eventType) {
      case "CREATED":
        return `New stream created (#${streamId})`;
      case "TOPPED_UP":
        return `Topped up Stream #${streamId} with ${amount} tokens`;
      case "WITHDRAWN":
        return `Withdrew ${amount} tokens from Stream #${streamId}`;
      case "CANCELLED":
        return `Stream #${streamId} was cancelled`;
      case "COMPLETED":
        return `Stream #${streamId} was completed`;
      case "PAUSED":
        return `Stream #${streamId} was paused`;
      case "RESUMED":
        return `Stream #${streamId} was resumed`;
      default:
        return `Event on Stream #${streamId}`;
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
      <div className="flex justify-end">
        <Button
          onClick={exportToCSV}
          variant="outline"
          size="sm"
          className="flex items-center gap-2"
          disabled={events.length === 0}
        >
          <Download className="h-4 w-4" /> Export CSV
        </Button>
      </div>

      <div className="relative space-y-4 before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-slate-700 before:to-transparent">
        {events.map((event, index) => (
          <div
            key={`${event.id}-${index}`}
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
                    {formatEventMessage(event)}
                  </p>
                  <time className="text-xs text-slate-400 flex items-center gap-1 mt-1">
                    {new Date(event.timestamp * 1000).toLocaleString()}
                  </time>
                </div>
                <span className="text-[10px] uppercase tracking-wider px-2 py-1 rounded bg-accent/10 text-accent font-bold border border-accent/20">
                  {event.eventType}
                </span>
              </div>

              {event.txHash && (
                <div className="mt-4 pt-4 border-t border-white/5 flex items-center justify-between">
                  <TransactionTracker
                    status="confirmed"
                    txHash={event.txHash}
                    streamId={event.streamId.toString()}
                  />
                  <a
                    href={`https://stellar.expert/explorer/testnet/tx/${event.txHash}`}
                    target="_blank"
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

      {events.length === 0 && !isLoading && (
        <div className="text-center py-12 text-slate-400 bg-white/5 rounded-xl border border-dashed border-slate-700">
          No activity found for this filter.
        </div>
      )}
    </div>
  );
};
