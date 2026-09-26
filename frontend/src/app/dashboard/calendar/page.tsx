"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { ArrowLeft, Calendar as CalendarIcon, Filter } from "lucide-react";
import { useWallet } from "@/context/wallet-context";
import { getApiBaseUrl } from "@/lib/api/_shared";
import { logger } from "@/lib/logger";
import { CalendarView } from "@/components/dashboard/CalendarView";
import { CashflowChart } from "@/components/dashboard/CashflowChart";

interface Stream {
  id: string;
  streamId: number;
  sender: string;
  recipient: string;
  tokenSymbol: string;
  ratePerSecond: number;
  depositedAmount: string;
  withdrawnAmount: string;
  startTime: number;
  endTime?: number;
  isActive: boolean;
  isPaused?: boolean;
  status: string;
}

const API_BASE_URL = `${getApiBaseUrl()}/v1`;

export default function DashboardCalendarPage() {
  const { session, isHydrated } = useWallet();
  const [streams, setStreams] = useState<Stream[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [selectedToken, setSelectedToken] = useState("all");
  const [direction, setDirection] = useState<"all" | "incoming" | "outgoing">("all");
  const [projectionDays, setProjectionDays] = useState<7 | 30 | 90>(30);

  // Load streams on mount / wallet change
  useEffect(() => {
    if (!isHydrated || !session?.publicKey) return;

    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch(
          `${API_BASE_URL}/streams?user=${session!.publicKey}`,
          { signal: controller.signal }
        );

        if (!response.ok) {
          throw new Error("Failed to fetch streams");
        }

        const data = await response.json();
        const streamList = Array.isArray(data) ? data : data.data ?? [];

        // Map API response to our Stream type
        const mappedStreams: Stream[] = streamList.map((s: Record<string, unknown>) => ({
          id: s.id as string,
          streamId: s.streamId as number,
          sender: s.sender as string,
          recipient: s.recipient as string,
          tokenSymbol: s.tokenSymbol || "USDC",
          ratePerSecond: Number(s.ratePerSecond) || 0,
          depositedAmount: (s.depositedAmount as string) || "0",
          withdrawnAmount: (s.withdrawnAmount as string) || "0",
          startTime: s.startTime as number,
          endTime: s.endTime as number | undefined,
          isActive: s.isActive as boolean,
          isPaused: s.isPaused as boolean,
          status: (s.status as string) || "unknown",
        }));

        setStreams(mappedStreams);
        setError(null);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        logger.error("Failed to fetch streams:", err);
        setError(err instanceof Error ? err.message : "Failed to load streams");
      } finally {
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [isHydrated, session?.publicKey]);

  // Get unique tokens from streams
  const uniqueTokens = React.useMemo(() => {
    const tokens = new Set(streams.map((s) => s.tokenSymbol));
    return ["all", ...Array.from(tokens)];
  }, [streams]);

  if (!isHydrated) {
    return (
      <main className="min-h-screen p-4 md:p-8 bg-gradient-to-br from-zinc-950 via-zinc-900 to-black">
        <div className="max-w-6xl mx-auto space-y-6">
          <div className="flex items-center gap-4">
            <div className="h-9 w-9 rounded-lg bg-slate-800/60 animate-pulse" />
            <div className="space-y-2">
              <div className="h-3 w-24 rounded-full bg-slate-800/60 animate-pulse" />
              <div className="h-6 w-40 rounded-md bg-slate-800/60 animate-pulse" />
            </div>
          </div>
          <div className="glass-card p-6 h-96 animate-pulse" />
        </div>
      </main>
    );
  }

  if (loading) {
    return (
      <main className="min-h-screen p-4 md:p-8 bg-gradient-to-br from-zinc-950 via-zinc-900 to-black">
        <div className="max-w-6xl mx-auto space-y-6">
          <div className="flex items-center gap-4">
            <div className="h-9 w-9 rounded-lg bg-slate-800/60 animate-pulse" />
            <div className="space-y-2">
              <div className="h-3 w-24 rounded-full bg-slate-800/60 animate-pulse" />
              <div className="h-6 w-40 rounded-md bg-slate-800/60 animate-pulse" />
            </div>
          </div>
          <div className="glass-card p-6 h-96 animate-pulse" />
          <div className="glass-card p-6 h-64 animate-pulse" />
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="min-h-screen p-4 md:p-8 bg-gradient-to-br from-zinc-950 via-zinc-900 to-black">
        <div className="max-w-6xl mx-auto">
          <div className="glass-card p-8 text-center">
            <CalendarIcon className="h-12 w-12 text-red-400 mx-auto mb-4" />
            <p className="text-red-400 mb-4">{error}</p>
            <Link href="/dashboard" className="text-accent hover:underline">
              ← Back to Dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-4 md:p-8 bg-gradient-to-br from-zinc-950 via-zinc-900 to-black">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Link
            href="/dashboard"
            className="p-2 rounded-lg hover:bg-white/5 transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Cashflow Calendar</h1>
            <p className="text-slate-400 text-sm">
              Visualize your stream timelines and project net cashflow
            </p>
          </div>
        </div>

        {/* Filters */}
        <div className="glass-card rounded-2xl border-slate-800 p-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-slate-400" />
              <span className="text-sm text-slate-400">Filters:</span>
            </div>

            {/* Token filter */}
            <select
              value={selectedToken}
              onChange={(e) => setSelectedToken(e.target.value)}
              className="px-3 py-1.5 text-sm rounded-lg bg-slate-800/50 border border-slate-700 outline-none focus:border-accent"
            >
              {uniqueTokens.map((token) => (
                <option key={token} value={token}>
                  {token === "all" ? "All Tokens" : token}
                </option>
              ))}
            </select>

            {/* Direction filter */}
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as typeof direction)}
              className="px-3 py-1.5 text-sm rounded-lg bg-slate-800/50 border border-slate-700 outline-none focus:border-accent"
            >
              <option value="all">All Directions</option>
              <option value="incoming">Incoming</option>
              <option value="outgoing">Outgoing</option>
            </select>
          </div>
        </div>

        {/* Calendar View */}
        <CalendarView
          streams={streams}
          selectedToken={selectedToken}
          direction={direction}
          userPublicKey={session?.publicKey}
        />

        {/* Cashflow Chart */}
        <CashflowChart
          streams={streams}
          userPublicKey={session?.publicKey}
          days={projectionDays}
          onDaysChange={setProjectionDays}
          tokenFilter={selectedToken}
        />
      </div>
    </main>
  );
}
