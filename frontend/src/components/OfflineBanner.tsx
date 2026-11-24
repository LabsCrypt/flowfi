"use client";

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { minutesSince, useNetworkStatus } from "@/hooks/useNetworkStatus";
import { useI18n } from "@/context/i18n-provider";

export function OfflineBanner() {
  const { isOnline, lastSynced } = useNetworkStatus();
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (isOnline) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [isOnline]);

  if (isOnline) return null;

  let time = t("offline.never");
  if (lastSynced !== null) {
    const mins = minutesSince(lastSynced, now);
    time = mins < 1 ? t("offline.justNow") : t("offline.minutesAgo", { count: mins });
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      className="flex items-center justify-center gap-2 border-b border-amber-500/40 bg-amber-500/15 px-4 py-1.5 text-xs font-medium text-amber-200"
    >
      <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{t("offline.banner")}</span>
      <span className="rounded-full bg-amber-500/25 px-2 py-0.5">{t("offline.lastSynced", { time })}</span>
    </div>
  );
}
