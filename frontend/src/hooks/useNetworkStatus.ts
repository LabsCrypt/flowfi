"use client";

import { useCallback, useEffect, useState } from "react";

export const LAST_SYNCED_KEY = "flowfi-last-synced";

function readLastSynced(): number | null {
  try {
    const raw = localStorage.getItem(LAST_SYNCED_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeLastSynced(at: number): void {
  try {
    localStorage.setItem(LAST_SYNCED_KEY, String(at));
  } catch {
    /* storage unavailable */
  }
}

/** Minutes elapsed since `at` (never negative). */
export function minutesSince(at: number, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - at) / 60_000));
}

export function useNetworkStatus() {
  // Assume online on the server / first render to keep hydration stable.
  const [isOnline, setIsOnline] = useState(true);
  const [lastSynced, setLastSynced] = useState<number | null>(null);

  const markSynced = useCallback((at: number = Date.now()) => {
    writeLastSynced(at);
    setLastSynced(at);
  }, []);

  useEffect(() => {
    const online = typeof navigator === "undefined" ? true : navigator.onLine;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsOnline(online);
    if (online) markSynced();
    else setLastSynced(readLastSynced());

    const goOnline = () => {
      setIsOnline(true);
      markSynced();
    };
    const goOffline = () => {
      setIsOnline(false);
      setLastSynced(readLastSynced());
    };
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "flowfi-synced" && typeof e.data.at === "number") markSynced(e.data.at);
    };

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, [markSynced]);

  return { isOnline, lastSynced };
}
