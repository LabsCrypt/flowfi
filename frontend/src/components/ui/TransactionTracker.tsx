"use client";
import React from "react";

export type TransactionStepStatus = "pending" | "current" | "completed" | "error";

export interface TransactionStep {
  id: string;
  label: string;
  description?: string;
  status: TransactionStepStatus;
}

interface TransactionTrackerProps {
  steps: TransactionStep[];
  className?: string;
}

export const TransactionTracker: React.FC<TransactionTrackerProps> = ({ steps, className = "" }) => {
  return (
    <div className={`flex flex-col gap-6 ${className}`}>
      {steps.map((step, index) => (
        <div key={step.id} className="relative flex items-start gap-4">
          {/* Connector Line */}
          {index < steps.length - 1 && (
            <div 
              className={`absolute left-[15px] top-[30px] w-[2px] h-[calc(100%-4px)] bg-glass-border
                ${step.status === "completed" ? "bg-accent/50" : "bg-white/10"}`}
            />
          )}

          {/* Icon/Circle */}
          <div className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-glass-border bg-slate-900 transition-colors duration-300">
            {step.status === "completed" ? (
              <div className="flex h-full w-full items-center justify-center rounded-full bg-accent text-white">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            ) : step.status === "current" ? (
              <div className="flex h-full w-full items-center justify-center rounded-full border-2 border-accent text-accent animate-pulse">
                <div className="h-2 w-2 rounded-full bg-accent" />
              </div>
            ) : step.status === "error" ? (
              <div className="flex h-full w-full items-center justify-center rounded-full bg-red-500 text-white">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
            ) : (
              <div className="h-2 w-2 rounded-full bg-slate-700" />
            )}
          </div>

          {/* Text */}
          <div className="flex flex-col">
            <span className={`text-sm font-bold transition-colors duration-300
              ${step.status === "current" ? "text-white" : 
                step.status === "completed" ? "text-accent" : 
                step.status === "error" ? "text-red-400" : "text-slate-500"}`}>
              {step.label}
            </span>
            {step.description && (
              <span className="text-xs text-slate-400 mt-1">
                {step.description}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};
