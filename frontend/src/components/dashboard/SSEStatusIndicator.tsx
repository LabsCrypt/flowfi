"use client";

import { useMemo } from "react";
import { AlertCircle } from "lucide-react";

interface SSEStatusIndicatorProps {
  connected: boolean;
  reconnecting: boolean;
  error: Error | null;
  /** Timestamp (ms since epoch) of the last received SSE event. */
  lastEventAt?: number | null;
  /** Optional handler for the "Retry Now" button (issue #1508). */
  onRetry?: () => void;
}

/** Returns a human-readable relative time string, e.g. "2 minutes ago". */
function formatRelativeTime(timestampMs: number): string {
  const diffSeconds = Math.floor((Date.now() - timestampMs) / 1000);
  if (diffSeconds < 5) return "just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  return `${diffHours}h ago`;
}

export function SSEStatusIndicator({
  connected,
  reconnecting,
  error,
  lastEventAt,
  onRetry,
}: SSEStatusIndicatorProps) {
  // Show disconnect banner when error occurs
  const showDisconnectBanner = useMemo(() => {
    return !!error || (reconnecting && !connected);
  }, [connected, reconnecting, error]);

  const isLive = connected && !reconnecting && !error;
  const isReconnecting = reconnecting;
  const isDisconnected = !connected || error;

  const statusLabel = isLive
    ? "Connected"
    : isReconnecting
      ? "Reconnecting"
      : "Offline";

  const lastSyncText = lastEventAt
    ? `Last sync: ${formatRelativeTime(lastEventAt)}`
    : "No events received yet";

  const tooltipText = `${statusLabel} — ${lastSyncText}`;

  return (
    <>
      {/* Status Indicator Dot + Text */}
      <div className="flex items-center gap-2">
        <div
          className="relative inline-flex"
          role="status"
          aria-label={tooltipText}
          title={tooltipText}
        >
          <span
            className={`inline-block w-2.5 h-2.5 rounded-full ${
              isLive
                ? "bg-green-500 animate-pulse"
                : isReconnecting
                  ? "bg-yellow-500 animate-pulse"
                  : "bg-red-500"
            }`}
          />
        </div>
        <span
          className={`text-sm font-medium ${
            isLive
              ? "text-green-600 dark:text-green-400"
              : isReconnecting
                ? "text-yellow-600 dark:text-yellow-400"
                : "text-red-600 dark:text-red-400"
          }`}
        >
          {isLive
            ? "Live"
            : isReconnecting
              ? "Reconnecting..."
              : "Disconnected"}
        </span>
      </div>

      {/* Disconnect Banner */}
      {showDisconnectBanner && isDisconnected && (
        <div
          className={`fixed top-0 left-0 right-0 z-50 ${
            isReconnecting
              ? "bg-yellow-500/90"
              : "bg-red-500/90"
          } text-white p-4 flex items-center justify-between gap-4 animate-in slide-in-from-top`}
          role="alert"
        >
          <div className="flex items-center gap-3 max-w-2xl">
            <AlertCircle size={20} className="flex-shrink-0" />
            <p className="text-sm font-medium">
              {isReconnecting
                ? "Real-time updates paused. Reconnecting..."
                : "Real-time updates paused. Data may be stale."}
            </p>
          </div>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded-md bg-white/20 px-3 py-1.5 text-sm font-semibold hover:bg-white/30 transition-colors"
            >
              Retry Now
            </button>
          )}
        </div>
      )}
    </>
  );
}
