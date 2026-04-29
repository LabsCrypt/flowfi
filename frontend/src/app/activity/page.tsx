"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useWallet } from "@/context/wallet-context";
import { ActivityHistory } from "@/components/dashboard/ActivityHistory";
import { BackendStreamEvent } from "@/lib/api-types";
import { Button } from "@/components/ui/Button";
import { Loader2 } from "lucide-react";

const PAGE_SIZE = 10;
const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"
).replace(/\/+$/, "");

const TABS = [
  { id: "ALL", label: "All" },
  { id: "CREATED", label: "Created" },
  { id: "WITHDRAWN", label: "Withdrawals" },
  { id: "TOPPED_UP", label: "Top-ups" },
  { id: "CANCELLED", label: "Cancellations" },
  { id: "PAUSED", label: "Paused/Resumed" },
];

export default function ActivityPage() {
  const { session, status } = useWallet();
  const [events, setEvents] = useState<BackendStreamEvent[]>([]);
  const [activeTab, setActiveTab] = useState("ALL");
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  const fetchActivity = useCallback(
    async (pageNum: number, tab: string, append: boolean = false) => {
      if (!session?.publicKey) return;
      setLoading(true);

      try {
        // The 'PAUSED' tab is a UX shortcut that surfaces both PAUSED and RESUMED.
        const typeFilter = tab === "PAUSED" ? "PAUSED,RESUMED" : tab;
        const typeQuery = tab === "ALL" ? "" : `&type=${encodeURIComponent(typeFilter)}`;
        const url =
          `${API_BASE_URL}/v1/events?address=${encodeURIComponent(session.publicKey)}` +
          `&page=${pageNum}&limit=${PAGE_SIZE}${typeQuery}`;

        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch activity (${response.status})`);
        }
        const data = await response.json();

        const next: BackendStreamEvent[] = Array.isArray(data?.events)
          ? data.events
          : [];

        setEvents((prev) => (append ? [...prev, ...next] : next));

        // Prefer the server-provided hasMore; fall back to a length heuristic.
        if (typeof data?.hasMore === "boolean") {
          setHasMore(data.hasMore);
        } else {
          setHasMore(next.length === PAGE_SIZE);
        }
      } catch (error) {
        console.error("Failed to fetch activity:", error);
        if (!append) setEvents([]);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    [session?.publicKey],
  );

  useEffect(() => {
    if (status !== "connected") return;
    setPage(1);
    fetchActivity(1, activeTab, false);
  }, [activeTab, status, fetchActivity]);

  const loadMore = () => {
    const nextPage = page + 1;
    setPage(nextPage);
    fetchActivity(nextPage, activeTab, true);
  };

  if (status !== "connected") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
        <h1 className="text-2xl font-bold mb-2">Access Denied</h1>
        <p className="text-slate-400">
          Please connect your wallet to view your stream history.
        </p>
      </div>
    );
  }

  return (
    <main className="max-w-4xl mx-auto py-8 px-4 sm:px-6">
      <header className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Stream Activity</h1>
        <p className="text-slate-400">
          Track all your incoming and outgoing payment stream events.
        </p>
      </header>

      {/* Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-4 mb-6 no-scrollbar">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all whitespace-nowrap border ${
              activeTab === tab.id
                ? "bg-accent text-white border-accent"
                : "bg-white/5 text-slate-400 border-white/10 hover:bg-white/10"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <ActivityHistory events={events} isLoading={loading} />

      {hasMore && (
        <div className="mt-12 flex justify-center">
          <Button
            variant="secondary"
            onClick={loadMore}
            disabled={loading}
            className="w-full sm:w-auto min-w-[200px]"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Load More Activity
          </Button>
        </div>
      )}
    </main>
  );
}
