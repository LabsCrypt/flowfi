"use client";

import { useState, useMemo } from "react";
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon } from "lucide-react";

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

interface CalendarViewProps {
  streams: Stream[];
  selectedToken?: string;
  direction?: "all" | "incoming" | "outgoing";
  userPublicKey?: string;
}

type ViewMode = "month" | "week";

interface CalendarDay {
  date: Date;
  isCurrentMonth: boolean;
  isToday: boolean;
  streams: StreamEvent[];
}

interface StreamEvent {
  stream: Stream;
  type: "start" | "end" | "active" | "cliff";
  date: Date;
}

/** Get streams that are active on a specific date */
function getStreamsForDate(date: Date, streams: Stream[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  streams.forEach((stream) => {
    const streamStart = new Date(stream.startTime * 1000);
    const streamEnd = stream.endTime ? new Date(stream.endTime * 1000) : null;

    if (streamStart <= dayEnd && (!streamEnd || streamEnd >= dayStart)) {
      events.push({ stream, type: "active", date: streamStart });
    }

    if (
      streamStart.getFullYear() === date.getFullYear() &&
      streamStart.getMonth() === date.getMonth() &&
      streamStart.getDate() === date.getDate()
    ) {
      events.push({ stream, type: "start", date: streamStart });
    }

    if (
      streamEnd &&
      streamEnd.getFullYear() === date.getFullYear() &&
      streamEnd.getMonth() === date.getMonth() &&
      streamEnd.getDate() === date.getDate()
    ) {
      events.push({ stream, type: "end", date: streamEnd });
    }
  });

  return events;
}

export function CalendarView({
  streams,
  selectedToken = "all",
  direction = "all",
  userPublicKey,
}: CalendarViewProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [viewMode, setViewMode] = useState<ViewMode>("month");

  // Filter streams based on criteria
  const filteredStreams = useMemo(() => {
    return streams.filter((stream) => {
      if (selectedToken !== "all" && stream.tokenSymbol !== selectedToken) return false;
      if (direction === "incoming" && stream.sender === userPublicKey) return false;
      if (direction === "outgoing" && stream.recipient === userPublicKey) return false;
      return true;
    });
  }, [streams, selectedToken, direction, userPublicKey]);

  // Generate calendar days
  const calendarDays = useMemo(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startOffset = firstDay.getDay();
    const totalDays = lastDay.getDate();

    const days: CalendarDay[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const prevMonthLastDay = new Date(year, month, 0).getDate();
    for (let i = startOffset - 1; i >= 0; i--) {
      const date = new Date(year, month - 1, prevMonthLastDay - i);
      days.push({
        date,
        isCurrentMonth: false,
        isToday: date.getTime() === today.getTime(),
        streams: getStreamsForDate(date, filteredStreams),
      });
    }

    for (let day = 1; day <= totalDays; day++) {
      const date = new Date(year, month, day);
      days.push({
        date,
        isCurrentMonth: true,
        isToday: date.getTime() === today.getTime(),
        streams: getStreamsForDate(date, filteredStreams),
      });
    }

    const remaining = 42 - days.length;
    for (let day = 1; day <= remaining; day++) {
      const date = new Date(year, month + 1, day);
      days.push({
        date,
        isCurrentMonth: false,
        isToday: date.getTime() === today.getTime(),
        streams: getStreamsForDate(date, filteredStreams),
      });
    }

    return days;
  }, [currentDate, filteredStreams]);

  const goToPrevMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1));
  };

  const goToNextMonth = () => {
    setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1));
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="glass-card rounded-2xl border-slate-800 p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <CalendarIcon className="h-5 w-5 text-accent" />
          <h3 className="text-lg font-semibold">Stream Calendar</h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewMode("month")}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
              viewMode === "month"
                ? "bg-accent/20 text-accent"
                : "text-slate-400 hover:text-white"
            }`}
          >
            Month
          </button>
          <button
            onClick={() => setViewMode("week")}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
              viewMode === "week"
                ? "bg-accent/20 text-accent"
                : "text-slate-400 hover:text-white"
            }`}
          >
            Week
          </button>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={goToPrevMonth}
          className="p-2 rounded-lg hover:bg-white/5 transition-colors"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-4">
          <h4 className="text-lg font-semibold">
            {currentDate.toLocaleString("default", { month: "long", year: "numeric" })}
          </h4>
          <button
            onClick={goToToday}
            className="px-3 py-1 text-sm rounded-lg border border-slate-700 hover:border-accent transition-colors"
          >
            Today
          </button>
        </div>
        <button
          onClick={goToNextMonth}
          className="p-2 rounded-lg hover:bg-white/5 transition-colors"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      {/* Calendar Grid */}
      <div className="grid grid-cols-7 gap-px bg-slate-800/50 rounded-xl overflow-hidden">
        {dayNames.map((day) => (
          <div
            key={day}
            className="bg-slate-900/50 p-2 text-center text-sm font-medium text-slate-400"
          >
            {day}
          </div>
        ))}

        {calendarDays.map((day, index) => (
          <div
            key={index}
            className={`bg-slate-900/30 p-2 min-h-[100px] ${
              !day.isCurrentMonth ? "opacity-50" : ""
            } ${day.isToday ? "ring-1 ring-accent" : ""}`}
          >
            <div className="flex items-center justify-between mb-2">
              <span
                className={`text-sm ${
                  day.isToday
                    ? "text-accent font-bold"
                    : day.isCurrentMonth
                    ? "text-slate-300"
                    : "text-slate-600"
                }`}
              >
                {day.date.getDate()}
              </span>
              {day.streams.length > 0 && (
                <span className="text-xs text-slate-500">
                  {day.streams.length}
                </span>
              )}
            </div>

            <div className="space-y-1">
              {day.streams.slice(0, 3).map((event, i) => (
                <div
                  key={i}
                  className={`px-1.5 py-0.5 rounded text-xs truncate ${
                    event.type === "start"
                      ? "bg-green-500/20 text-green-400"
                      : event.type === "end"
                      ? "bg-red-500/20 text-red-400"
                      : "bg-blue-500/20 text-blue-400"
                  }`}
                  title={`${event.stream.tokenSymbol} stream`}
                >
                  {event.stream.tokenSymbol}
                </div>
              ))}
              {day.streams.length > 3 && (
                <span className="text-xs text-slate-500">
                  +{day.streams.length - 3} more
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-4 text-sm text-slate-400">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-green-500" />
          <span>Incoming</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-blue-500" />
          <span>Outgoing</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-yellow-500" />
          <span>Start/End</span>
        </div>
      </div>
    </div>
  );
}
