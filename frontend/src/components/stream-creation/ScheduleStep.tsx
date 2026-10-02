"use client";

import { useMemo } from "react";
import { AlertTriangle } from "lucide-react";
import type { DurationUnit } from "@/lib/stream-validation";

interface ScheduleStepProps {
  formData: {
    duration: string;
    durationUnit: DurationUnit;
    descriptionTag?: string;
    memo?: string;
  };
  errors: Record<string, string | undefined>;
  onUpdate: (data: Partial<ScheduleStepProps["formData"]>) => void;
}

const MAX_MEMO_BYTES = 28;

export function ScheduleStep({ formData, errors, onUpdate }: ScheduleStepProps) {
  const memo = formData.memo || "";

  // UTF-8 byte length, derived during render rather than stored in state.
  const memoByteCount = useMemo(() => new TextEncoder().encode(memo).length, [memo]);

  const isNearLimit = memoByteCount >= MAX_MEMO_BYTES * 0.8;
  const isOverLimit = memoByteCount > MAX_MEMO_BYTES;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-2">Schedule & Details</h2>
        <p className="text-slate-400">Configure the stream duration and add optional details</p>
      </div>

      <div className="space-y-4">
        <div>
          <label htmlFor="duration" className="block text-sm font-medium mb-2">
            Duration
          </label>
          <div className="flex gap-3">
            <input
              id="duration"
              type="number"
              min="1"
              value={formData.duration}
              onChange={(e) => onUpdate({ duration: e.target.value })}
              className="flex-1 px-4 py-3 rounded-lg bg-black/40 border border-white/10 focus:border-accent outline-none"
              placeholder="Enter duration"
            />
            <select
              value={formData.durationUnit}
              onChange={(e) => onUpdate({ durationUnit: e.target.value as DurationUnit })}
              className="px-4 py-3 rounded-lg bg-black/40 border border-white/10 focus:border-accent outline-none"
            >
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
              <option value="months">Months</option>
            </select>
          </div>
          {errors.duration && (
            <p className="text-red-400 text-sm mt-1" role="alert">{errors.duration}</p>
          )}
        </div>

        <div>
          <label htmlFor="descriptionTag" className="block text-sm font-medium mb-2">
            Description Tag
          </label>
          <input
            id="descriptionTag"
            type="text"
            value={formData.descriptionTag}
            onChange={(e) => onUpdate({ descriptionTag: e.target.value })}
            className="w-full px-4 py-3 rounded-lg bg-black/40 border border-white/10 focus:border-accent outline-none"
            placeholder="e.g., salary, contractor-payment, subscription"
          />
          {errors.descriptionTag && (
            <p className="text-red-400 text-sm mt-1" role="alert">{errors.descriptionTag}</p>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label htmlFor="memo" className="block text-sm font-medium">
              Memo (Optional)
            </label>
            <span
              className={`text-xs font-mono ${
                isOverLimit
                  ? "text-red-400"
                  : isNearLimit
                  ? "text-yellow-400"
                  : "text-slate-400"
              }`}
            >
              {memoByteCount} / {MAX_MEMO_BYTES} bytes
            </span>
          </div>
          <textarea
            id="memo"
            value={memo}
            onChange={(e) => onUpdate({ memo: e.target.value })}
            className={`w-full px-4 py-3 rounded-lg bg-black/40 border outline-none resize-none ${
              isOverLimit
                ? "border-red-500/50 focus:border-red-500"
                : "border-white/10 focus:border-accent"
            }`}
            placeholder="Add a note (max 28 bytes)"
            rows={3}
            maxLength={MAX_MEMO_BYTES * 4} // Allow more chars for validation, UTF-8 can use up to 4 bytes per char
          />
          {isOverLimit && (
            <div className="mt-2 flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
              <AlertTriangle className="h-4 w-4 text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-red-400 text-sm font-semibold">Memo exceeds byte limit</p>
                <p className="text-red-400/80 text-xs mt-1">
                  Stellar memos are limited to 28 bytes. Note that some characters use multiple bytes.
                </p>
              </div>
            </div>
          )}
          {isNearLimit && !isOverLimit && (
            <p className="text-yellow-400 text-xs mt-1">
              ⚠ Approaching byte limit - some characters use multiple bytes
            </p>
          )}
          <p className="text-slate-400 text-xs mt-1">
            Add a custom note to your stream transaction (UTF-8 encoded)
          </p>
        </div>
      </div>
    </div>
  );
}
