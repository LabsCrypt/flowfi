"use client";

import React, { useState, useMemo } from "react";
import { X, AlertCircle } from "lucide-react";

interface SSEStatusIndicatorProps {
  connected: boolean;
  reconnecting: boolean;
  error: Error | null;
}

export function SSEStatusIndicator({
  connected,
  reconnecting,
  error,
}: SSEStatusIndicatorProps) {
  // Show disconnect banner when error occurs
  const showDisconnectBanner = useMemo(() => {
    return !!error || (reconnecting && !connected);
  }, [connected, reconnecting, error]);

  const isLive = connected && !reconnecting && !error;
  const isReconnecting = reconnecting;
  const isDisconnected = !connected || error;

  return (
    <>
      {/* Status Indicator Dot + Text */}
      <div className="flex items-center gap-2">
        <div className="relative inline-flex">
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
          className="fixed top-0 left-0 right-0 z-50 bg-red-500/90 text-white p-4 flex items-center justify-between gap-4 animate-in slide-in-from-top"
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
        </div>
      )}
    </>
  );
}
