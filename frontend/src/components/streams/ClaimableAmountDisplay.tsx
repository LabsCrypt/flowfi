"use client";

import { useEffect, useState } from "react";
import { useClaimableAmount } from "@/hooks/useClaimableAmount";

interface ClaimableAmountDisplayProps {
  streamId: string;
  initialAmount: number; // The starting claimable amount
  ratePerSecond: number; // Rate in tokens/sec
  isPaused?: boolean;
  isActive: boolean;
  label?: string;
  pausedAt?: string;
}

export default function ClaimableAmountDisplay({
  streamId,
  initialAmount,
  ratePerSecond,
  isPaused = false,
  isActive,
  label = "Available to withdraw",
  pausedAt,
}: ClaimableAmountDisplayProps) {
  const { claimable, tick } = useClaimableAmount({
    streamId,
    initialClaimable: initialAmount,
    ratePerSecond,
    isActive,
    isPaused,
  });

  const [highlight, setHighlight] = useState(false);

  useEffect(() => {
    if (tick > 0 && isActive && !isPaused) {
      setHighlight(true);
      const timer = setTimeout(() => setHighlight(false), 200);
      return () => clearTimeout(timer);
    }
  }, [tick, isActive, isPaused]);

  const formatPausedTime = (pausedAtStr: string | undefined): string => {
    if (!pausedAtStr) return "";
    try {
      // Stream pausedAt might be in seconds or a date string
      const parsed = parseInt(pausedAtStr);
      const isSeconds = parsed.toString() === pausedAtStr && parsed < 10000000000;
      const pausedDate = isSeconds ? new Date(parsed * 1000) : new Date(pausedAtStr);
      
      const now = new Date();
      const diffMs = now.getTime() - pausedDate.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffDays > 0) return `Paused ${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
      if (diffHours > 0) return `Paused ${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
      if (diffMins > 0) return `Paused ${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
      return "Paused now";
    } catch {
      return "Paused";
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
      <span
        style={{
          position: "relative",
          display: "inline-flex",
          width: "0.75rem",
          height: "0.75rem",
        }}
      >
        <span
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "999px",
            background: isPaused ? "#ef4444" : "#10b981",
            opacity: isPaused ? 0.5 : 0.75,
            animation: isPaused ? "none" : "pulse-slow 4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
          }}
        />
        <span
          style={{
            position: "relative",
            display: "inline-flex",
            width: "0.75rem",
            height: "0.75rem",
            borderRadius: "999px",
            background: isPaused ? "#ef4444" : "#10b981",
          }}
        />
      </span>

      <p style={{ margin: 0, fontSize: "0.92rem", color: "var(--text-muted)" }}>
        {isPaused ? (
          formatPausedTime(pausedAt)
        ) : (
          <>
            {label}:{" "}
            <strong
              style={{
                fontSize: "1rem",
                color: highlight ? "#10b981" : "var(--text-main)",
                transition: "color 0.2s ease",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {claimable.toFixed(7)}
            </strong>
          </>
        )}
      </p>
    </div>
  );
}
