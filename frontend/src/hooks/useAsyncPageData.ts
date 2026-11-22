"use client";

import { useMemo } from "react";

/**
 * The state a page-level data view can be in, in priority order.
 *
 * `awaiting` means the page has no data source yet (wallet not connected, or
 * hydration still pending) and should render whatever "not mine yet" looks like
 * for that page. The remaining four are mutually exclusive and resolved by
 * `useAsyncPageData`.
 */
export type AsyncPageState = "awaiting" | "error" | "loading" | "empty" | "ready";

export interface AsyncPageDataInput {
  /** False until the page has something to load (connected / hydrated). */
  enabled: boolean;
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  /** Message to surface in the error state; `null` when there is none. */
  error?: string | null;
}

export interface AsyncPageData {
  state: AsyncPageState;
  isEnabled: boolean;
  isError: boolean;
  isLoading: boolean;
  isEmpty: boolean;
  isReady: boolean;
  error: string | null;
}

/**
 * Single source of truth for the loading / error / empty / ready scaffolding
 * that every page-level data view repeats.
 *
 * The precedence — error before loading before empty before ready — lives here
 * so an edge-case fix (a refetch in flight must not hide a failure, say) lands
 * once instead of per page. Pages keep their own markup and their own fetching
 * library; this only decides which branch is showing.
 */
export function useAsyncPageData(input: AsyncPageDataInput): AsyncPageData {
  const { enabled, isLoading, isError, isEmpty, error = null } = input;

  return useMemo(() => {
    let state: AsyncPageState;
    if (!enabled) state = "awaiting";
    else if (isError) state = "error";
    else if (isLoading) state = "loading";
    else if (isEmpty) state = "empty";
    else state = "ready";

    return {
      state,
      isEnabled: enabled,
      isError: state === "error",
      isLoading: state === "loading",
      isEmpty: state === "empty",
      isReady: state === "ready",
      error,
    };
  }, [enabled, isError, isLoading, isEmpty, error]);
}
