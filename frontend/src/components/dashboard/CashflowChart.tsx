"use client";

import { useMemo } from "react";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

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

interface CashflowChartProps {
  streams: Stream[];
  userPublicKey?: string;
  days?: 7 | 30 | 90;
  onDaysChange?: (days: 7 | 30 | 90) => void;
  tokenFilter?: string;
}

interface DailyFlow {
  date: Date;
  incoming: number;
  outgoing: number;
  net: number;
  cumulativeNet: number;
}

export function CashflowChart({
  streams,
  userPublicKey,
  days = 30,
  onDaysChange,
  tokenFilter = "all",
}: CashflowChartProps) {
  // Calculate daily flows
  const dailyFlows = useMemo(() => {
    const flows: DailyFlow[] = [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    for (let i = 0; i < days; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() + i);

      let incoming = 0;
      let outgoing = 0;

      streams.forEach((stream) => {
        // Skip if token filter doesn't match
        if (tokenFilter !== "all" && stream.tokenSymbol !== tokenFilter) {
          return;
        }

        const streamStart = new Date(stream.startTime * 1000);
        const streamEnd = stream.endTime ? new Date(stream.endTime * 1000) : null;

        // Check if stream is active on this date
        if (streamStart <= date && (!streamEnd || streamEnd >= date)) {
          const dailyAmount = stream.ratePerSecond * 86400;

          if (stream.sender === userPublicKey) {
            outgoing += dailyAmount;
          } else {
            incoming += dailyAmount;
          }
        }
      });

      flows.push({
        date,
        incoming,
        outgoing,
        net: incoming - outgoing,
        cumulativeNet: 0, // Will be calculated below
      });
    }

    // Calculate cumulative net flow
    let cumulative = 0;
    flows.forEach((flow) => {
      cumulative += flow.net;
      flow.cumulativeNet = cumulative;
    });

    return flows;
  }, [streams, days, userPublicKey, tokenFilter]);

  // Calculate summary statistics
  const summary = useMemo(() => {
    const totalIncoming = dailyFlows.reduce((sum, f) => sum + f.incoming, 0);
    const totalOutgoing = dailyFlows.reduce((sum, f) => sum + f.outgoing, 0);
    const totalNet = totalIncoming - totalOutgoing;
    const avgDailyNet = totalNet / days;
    const netFlowPerDay = avgDailyNet;

    return {
      totalIncoming,
      totalOutgoing,
      totalNet,
      netFlowPerDay,
      isPositive: totalNet >= 0,
    };
  }, [dailyFlows, days]);

  // Find min/max for chart scaling
  const { minCumulative, maxCumulative } = useMemo(() => {
    const cumulatives = dailyFlows.map((f) => f.cumulativeNet);

    return {
      minCumulative: Math.min(...cumulatives, 0),
      maxCumulative: Math.max(...cumulatives, 0),
    };
  }, [dailyFlows]);

  // Normalize values for chart rendering (0-100)
  const normalize = (value: number, min: number, max: number) => {
    const range = max - min || 1;
    return ((value - min) / range) * 100;
  };

  // Generate SVG path for cumulative line
  const cumulativePath = useMemo(() => {
    if (dailyFlows.length === 0) return "";

    const points = dailyFlows.map((flow, i) => {
      const x = (i / (dailyFlows.length - 1)) * 100;
      const y = 100 - normalize(flow.cumulativeNet, minCumulative, maxCumulative);
      return `${x},${y}`;
    });

    return `M ${points.join(" L ")}`;
  }, [dailyFlows, minCumulative, maxCumulative]);

  // Generate SVG area for cumulative line
  const cumulativeArea = useMemo(() => {
    if (dailyFlows.length === 0) return "";

    const points = dailyFlows.map((flow, i) => {
      const x = (i / (dailyFlows.length - 1)) * 100;
      const y = 100 - normalize(flow.cumulativeNet, minCumulative, maxCumulative);
      return `${x},${y}`;
    });

    return `M 0,100 L ${points.join(" L ")} L 100,100 Z`;
  }, [dailyFlows, minCumulative, maxCumulative]);

  return (
    <div className="glass-card rounded-2xl border-slate-800 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-lg font-semibold">Cashflow Projection</h3>
          <p className="text-sm text-slate-400 mt-1">
            Net flow over the next {days} days
          </p>
        </div>
        <div className="flex gap-2">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => onDaysChange?.(d as 7 | 30 | 90)}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                days === d
                  ? "bg-accent/20 text-accent"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="rounded-xl bg-slate-800/50 p-4">
          <p className="text-xs text-slate-400 mb-1">Total Incoming</p>
          <p className="text-lg font-bold text-green-400">
            ${summary.totalIncoming.toFixed(2)}
          </p>
        </div>
        <div className="rounded-xl bg-slate-800/50 p-4">
          <p className="text-xs text-slate-400 mb-1">Total Outgoing</p>
          <p className="text-lg font-bold text-red-400">
            ${summary.totalOutgoing.toFixed(2)}
          </p>
        </div>
        <div className="rounded-xl bg-slate-800/50 p-4">
          <p className="text-xs text-slate-400 mb-1">Net Flow</p>
          <p className={`text-lg font-bold ${summary.isPositive ? "text-green-400" : "text-red-400"}`}>
            {summary.isPositive ? "+" : ""}${summary.totalNet.toFixed(2)}
          </p>
        </div>
        <div className="rounded-xl bg-slate-800/50 p-4">
          <p className="text-xs text-slate-400 mb-1">Avg Daily Net</p>
          <div className="flex items-center gap-2">
            {summary.isPositive ? (
              <TrendingUp className="h-4 w-4 text-green-400" />
            ) : summary.netFlowPerDay < 0 ? (
              <TrendingDown className="h-4 w-4 text-red-400" />
            ) : (
              <Minus className="h-4 w-4 text-slate-400" />
            )}
            <p className={`text-lg font-bold ${summary.isPositive ? "text-green-400" : "text-red-400"}`}>
              ${Math.abs(summary.netFlowPerDay).toFixed(2)}/day
            </p>
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="relative h-64 bg-slate-900/30 rounded-xl p-4">
        {/* Y-axis labels */}
        <div className="absolute left-4 top-4 bottom-4 flex flex-col justify-between text-xs text-slate-500">
          <span>${maxCumulative.toFixed(0)}</span>
          <span>${((maxCumulative + minCumulative) / 2).toFixed(0)}</span>
          <span>${minCumulative.toFixed(0)}</span>
        </div>

        {/* Chart area */}
        <div className="ml-12 h-full relative">
          {/* Grid lines */}
          <div className="absolute inset-0 flex flex-col justify-between">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="border-t border-slate-800/50" />
            ))}
          </div>

          {/* Zero line */}
          <div
            className="absolute left-0 right-0 border-t border-slate-600 border-dashed"
            style={{
              top: `${100 - normalize(0, minCumulative, maxCumulative)}%`,
            }}
          />

          {/* SVG Chart */}
          <svg
            className="absolute inset-0 w-full h-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            {/* Area fill */}
            <path
              d={cumulativeArea}
              fill="url(#areaGradient)"
              opacity="0.3"
            />

            {/* Line */}
            <path
              d={cumulativePath}
              fill="none"
              stroke={summary.isPositive ? "#22c55e" : "#ef4444"}
              strokeWidth="0.5"
              vectorEffect="non-scaling-stroke"
            />

            {/* Gradient definition */}
            <defs>
              <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor={summary.isPositive ? "#22c55e" : "#ef4444"}
                  stopOpacity="0.4"
                />
                <stop
                  offset="100%"
                  stopColor={summary.isPositive ? "#22c55e" : "#ef4444"}
                  stopOpacity="0"
                />
              </linearGradient>
            </defs>
          </svg>

          {/* X-axis labels */}
          <div className="absolute -bottom-6 left-0 right-0 flex justify-between text-xs text-slate-500">
            <span>Today</span>
            <span>{days > 7 ? `${Math.floor(days / 2)}d` : ""}</span>
            <span>{days}d</span>
          </div>
        </div>
      </div>

      {/* Burn rate indicator */}
      <div className="mt-8 p-4 rounded-xl bg-slate-800/30">
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-400">Net Flow</span>
          <span className={`text-lg font-bold ${summary.isPositive ? "text-green-400" : "text-red-400"}`}>
            {summary.isPositive ? "+" : ""}${summary.netFlowPerDay.toFixed(2)} / day
          </span>
        </div>
      </div>
    </div>
  );
}
