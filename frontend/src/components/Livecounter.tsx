"use client";

import { useEffect, useState } from "react";

interface LiveCounterProps {
  initial: number;
  label?: string;
  isPaused?: boolean;
  pausedAt?: string;
}

export default function LiveCounter({ 
  initial, 
  label = "Live Streamed",
  isPaused = false,
  pausedAt,
}: LiveCounterProps) {
  const [amount, setAmount] = useState(initial);

  useEffect(() => {
    // Reset amount when initial value changes
    setAmount(initial);
  }, [initial]);

  useEffect(() => {
    // Don't increment if paused
    if (isPaused) {
      return;
    }

    const interval = setInterval(() => {
      setAmount((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [initial, isPaused]);

  const formatPausedTime = (pausedAtStr: string | undefined): string => {
    if (!pausedAtStr) return "";
    try {
      const pausedDate = new Date(pausedAtStr);
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
                color: "var(--text-main)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {amount.toLocaleString()}
            </strong>
          </>
        )}
      </p>
    </div>
  );
}