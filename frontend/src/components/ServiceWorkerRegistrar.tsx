"use client";

import { useEffect } from "react";

/** Registers /sw.js in production builds only, so dev HMR isn't cached. */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline support is progressive enhancement */
    });
  }, []);
  return null;
}
