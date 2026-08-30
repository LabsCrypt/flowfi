"use client";

import { useEffect } from "react";
import { useWallet } from "@/context/wallet-context";
import {
  clearDisposableAppData,
  isAppDataClearEvent,
} from "@/lib/app-data";

export function AppDataSync() {
  const { disconnect } = useWallet();

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (!isAppDataClearEvent(event.key)) return;

      clearDisposableAppData({ broadcast: false });
      disconnect();

      // Restore the app's default dark appearance without
      // recreating the cleared flowfi-theme storage key.
      document.documentElement.classList.remove("light");
      document.documentElement.classList.add("dark");
    };

    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, [disconnect]);

  return null;
}
