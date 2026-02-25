"use client";
import React from "react";

interface TokenStepProps {
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

const TOKENS = [
  { id: "USDC", name: "USDC", symbol: "USDC", description: "USD Coin" },
  { id: "XLM", name: "Stellar Lumens", symbol: "XLM", description: "Native Stellar token" },
  { id: "EURC", name: "EURC", symbol: "EURC", description: "Euro Coin" },
];

export const TokenStep: React.FC<TokenStepProps> = ({
  value,
  onChange,
  error,
}) => {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-semibold mb-2">Select Token</h3>
        <p className="text-sm text-slate-400 mb-4">
          Choose the token you want to stream to the recipient.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {TOKENS.map((token) => {
          const isSelected = value === token.id;
          return (
            <button
              key={token.id}
              type="button"
              onClick={() => onChange(token.id)}
              className={`p-4 rounded-lg border-2 transition-all text-left ${
                isSelected
                  ? "border-accent bg-accent/10 shadow-lg shadow-accent/10"
                  : "border-glass-border bg-glass hover:border-glass-highlight"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-lg">{token.symbol}</span>
                {isSelected && (
                  <svg
                    className="w-5 h-5 text-accent"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                )}
              </div>
              <p className="text-sm text-slate-400">{token.name}</p>
              <p className="text-xs text-slate-500 mt-1">{token.description}</p>
            </button>
          );
        })}
      </div>

      {error && (
        <p
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
    </div>
  );
};
