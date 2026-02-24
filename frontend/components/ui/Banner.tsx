"use client";

import { useSyncExternalStore } from "react";
import { X, AlertTriangle, Info, AlertCircle, CheckCircle } from "lucide-react";
import type { BannerConfig } from "@/lib/banner.config";

const VARIANTS = {
  info: {
    icon: Info,
    bg: "bg-[#eaf5ff] border-[#bde0ff]",
    text: "text-[#0f5a9a]",
    iconColor: "text-[#0ea5e9]",
    closeHover: "hover:bg-[#bde0ff]",
  },
  warning: {
    icon: AlertTriangle,
    bg: "bg-[#fff8ed] border-[#ffd49e]",
    text: "text-[#8a4f00]",
    iconColor: "text-[#f59e0b]",
    closeHover: "hover:bg-[#ffd49e]",
  },
  error: {
    icon: AlertCircle,
    bg: "bg-[#fff3f4] border-[#ffb3bc]",
    text: "text-[#8c2230]",
    iconColor: "text-[#b12f3f]",
    closeHover: "hover:bg-[#ffb3bc]",
  },
  success: {
    icon: CheckCircle,
    bg: "bg-[#edfff6] border-[#a6f4c5]",
    text: "text-[#065f46]",
    iconColor: "text-[#10b981]",
    closeHover: "hover:bg-[#a6f4c5]",
  },
} as const;

interface BannerProps {
  config: BannerConfig;
}

export function Banner({ config }: BannerProps) {
  const storageKey = `flowfi.banner.dismissed.${config.id}`;

  const dismissed = useSyncExternalStore(
    (onStoreChange) => {
      window.addEventListener("storage", onStoreChange);
      return () => window.removeEventListener("storage", onStoreChange);
    },
    () => localStorage.getItem(storageKey) === "true",
    () => false,
  );

  if (!config.enabled || dismissed) return null;

  const style = VARIANTS[config.variant ?? "info"];
  const Icon = style.icon;

  function handleDismiss() {
    localStorage.setItem(storageKey, "true");
    window.dispatchEvent(new StorageEvent("storage", { key: storageKey }));
  }

  return (
    <div
      role="banner"
      aria-live="polite"
      className={`w-full border-b animate-[slide-down_0.3s_ease-out] ${style.bg} ${style.text}`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-2.5 flex items-center gap-3 min-h-[2.75rem]">
        <Icon className={`shrink-0 w-4 h-4 ${style.iconColor}`} aria-hidden />
        <p className="flex-1 text-sm font-medium leading-snug">{config.message}</p>
        {config.link && (
          <a
            href={config.link.href}
            className="text-sm font-semibold underline underline-offset-2 shrink-0 opacity-80 hover:opacity-100 transition-opacity whitespace-nowrap"
          >
            {config.link.label}
          </a>
        )}
        {config.dismissible !== false && (
          <button
            onClick={handleDismiss}
            aria-label="Dismiss banner"
            className={`shrink-0 rounded-md p-1 transition-colors ${style.closeHover} opacity-70 hover:opacity-100`}
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
