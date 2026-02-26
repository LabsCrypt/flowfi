"use client";

import { useEffect, useState } from "react";

interface LiveCounterProps {
  initial: number;
  label?: string;
}

export default function LiveCounter({ initial, label = "Live Streamed" }: LiveCounterProps) {
  const [amount, setAmount] = useState(initial);

  useEffect(() => {
    const interval = setInterval(() => {
      setAmount((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, []);

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
            background: "#10b981",
            opacity: 0.75,
            animation: "pulse-slow 4s cubic-bezier(0.4, 0, 0.6, 1) infinite",
          }}
        />
        <span
          style={{
            position: "relative",
            display: "inline-flex",
            width: "0.75rem",
            height: "0.75rem",
            borderRadius: "999px",
            background: "#10b981",
          }}
        />
      </span>

      <p style={{ margin: 0, fontSize: "0.92rem", color: "var(--text-muted)" }}>
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
      </p>
    </div>
  );
}