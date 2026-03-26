"use client";
import React, { useMemo, useRef, useEffect } from "react";

interface ScheduleStepProps {
  duration: string;
  durationUnit: "seconds" | "minutes" | "hours" | "days" | "weeks" | "months";
  onDurationChange: (value: string) => void;
  onUnitChange: (value: "seconds" | "minutes" | "hours" | "days" | "weeks" | "months") => void;
  error?: string;
  amount?: string;
  token?: string;
}

const DURATION_UNITS = [
  { value: "seconds" as const, label: "Seconds" },
  { value: "minutes" as const, label: "Minutes" },
  { value: "hours" as const, label: "Hours" },
  { value: "days" as const, label: "Days" },
  { value: "weeks" as const, label: "Weeks" },
  { value: "months" as const, label: "Months" },
] as const;

export const ScheduleStep: React.FC<ScheduleStepProps> = ({
  duration,
  durationUnit,
  onDurationChange,
  onUnitChange,
  error,
  amount,
  token,
}) => {
  const durationInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on mount
  useEffect(() => {
    durationInputRef.current?.focus();
  }, []);

  const totalSeconds = useMemo(() => {
    if (!duration || parseFloat(duration) <= 0) {
      return null;
    }

    let seconds = parseFloat(duration);

    switch (durationUnit) {
      case "seconds":
        break;
      case "minutes":
        seconds *= 60;
        break;
      case "hours":
        seconds *= 3600;
        break;
      case "days":
        seconds *= 86400;
        break;
      case "weeks":
        seconds *= 604800;
        break;
      case "months":
        seconds *= 2592000; // 30 days
        break;
    }

    return seconds;
  }, [duration, durationUnit]);

  const ratePerSecond = useMemo(() => {
    if (!amount || !duration || parseFloat(amount) <= 0 || parseFloat(duration) <= 0) {
      return null;
    }

    const totalAmount = parseFloat(amount);
    if (!totalSeconds || totalSeconds <= 0) {
      return null;
    }

    return totalAmount / totalSeconds;
  }, [amount, duration, totalSeconds]);

  const formattedRate = useMemo(() => {
    if (!ratePerSecond) return null;

    if (ratePerSecond >= 1) {
      return `${ratePerSecond.toFixed(4)} ${token || ""}/sec`;
    } else if (ratePerSecond >= 0.0001) {
      return `${(ratePerSecond * 60).toFixed(4)} ${token || ""}/min`;
    } else {
      return `${(ratePerSecond * 3600).toFixed(4)} ${token || ""}/hr`;
    }
  }, [ratePerSecond, token]);

  const ratePerDayPreview = useMemo(() => {
    if (!ratePerSecond) return null;
    const dailyRate = ratePerSecond * 86400;
    if (token === "USDC" || token === "EURC") {
      return `$${dailyRate.toFixed(2)} / day`;
    }
    return `${dailyRate.toFixed(4)} ${token || ""} / day`;
  }, [ratePerSecond, token]);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-semibold mb-2">Stream Schedule</h3>
        <p className="text-sm text-slate-400 mb-4">
          Set how long the stream should last. The amount will be distributed
          evenly over this duration.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="duration"
            className="block text-sm font-medium mb-2 text-foreground"
          >
            Duration
          </label>
          <input
            ref={durationInputRef}
            id="duration"
            type="number"
            step="any"
            min="0"
            value={duration}
            onChange={(e) => onDurationChange(e.target.value)}
            placeholder="0"
            className={`w-full px-4 py-3 rounded-lg bg-glass border ${
              error
                ? "border-red-500 focus:border-red-500 focus:ring-red-500"
                : "border-glass-border focus:border-accent focus:ring-accent"
            } focus:outline-none focus:ring-2 focus:ring-opacity-50 transition-colors text-foreground placeholder-slate-500`}
            aria-invalid={!!error}
            aria-describedby={error ? "duration-error" : undefined}
          />
        </div>

        <div>
          <label
            htmlFor="duration-unit"
            className="block text-sm font-medium mb-2 text-foreground"
          >
            Unit
          </label>
          <select
            id="duration-unit"
            value={durationUnit}
            onChange={(e) =>
              onUnitChange(
                e.target.value as "seconds" | "minutes" | "hours" | "days" | "weeks" | "months"
              )
            }
            className="w-full px-4 py-3 rounded-lg bg-glass border border-glass-border focus:border-accent focus:ring-accent focus:outline-none focus:ring-2 focus:ring-opacity-50 transition-colors text-foreground"
          >
            {DURATION_UNITS.map((unit) => (
              <option key={unit.value} value={unit.value}>
                {unit.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <p
          id="duration-error"
          className="mt-2 text-sm text-red-400 flex items-center gap-1"
          role="alert"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          {error}
        </p>
      )}

      {amount && duration && ratePerSecond && !error && (
        <div className="mt-6 space-y-3">
          {ratePerDayPreview && (
            <div className="p-4 rounded-lg bg-gradient-to-r from-accent/20 to-accent-tertiary/10 border border-accent/30">
              <p className="text-xs uppercase tracking-wider text-accent/80 font-semibold">
                Live Stream Rate Preview
              </p>
              <p className="mt-1 text-xl font-bold text-foreground">{ratePerDayPreview}</p>
            </div>
          )}
          <div className="p-4 rounded-lg bg-accent/5 border border-accent/20">
            <h4 className="font-semibold text-sm mb-2 text-accent">
              Stream Summary
            </h4>
            <div className="space-y-1 text-sm text-slate-300">
              <p>
                <span className="text-slate-400">Total Amount:</span>{" "}
                <strong className="text-foreground">{amount} {token || ""}</strong>
              </p>
              <p>
                <span className="text-slate-400">Duration:</span>{" "}
                <strong className="text-foreground">
                  {duration} {DURATION_UNITS.find((u) => u.value === durationUnit)?.label}
                </strong>
              </p>
              <p>
                <span className="text-slate-400">Stream Rate:</span>{" "}
                <strong className="text-foreground">{formattedRate}</strong>
              </p>
              <p>
                <span className="text-slate-400">Rate / Day:</span>{" "}
                <strong className="text-foreground">{ratePerDayPreview}</strong>
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
