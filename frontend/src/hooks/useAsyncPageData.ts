import { useWallet } from "@/context/wallet-context";

export interface AsyncPageDataOptions<T> {
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  data?: T[];
}

export interface AsyncPageDataState {
  isHydrated: boolean;
  isConnected: boolean;
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  isEmpty: boolean;
}

/**
 * Shared hook to encapsulate async page state (hydration, wallet connection,
 * loading state, error parsing, and empty state evaluation).
 */
export function useAsyncPageData<T>(options: AsyncPageDataOptions<T>): AsyncPageDataState {
  const { session, status, isHydrated } = useWallet();

  const isConnected = status === "connected" && Boolean(session?.publicKey);
  const isLoading = !isHydrated || (isConnected && Boolean(options.isLoading));
  const isError = isConnected && Boolean(options.isError);
  const isEmpty =
    isConnected &&
    !isLoading &&
    !isError &&
    Array.isArray(options.data) &&
    options.data.length === 0;

  const errorMessage =
    options.error instanceof Error
      ? options.error.message
      : typeof options.error === "string"
      ? options.error
      : undefined;

  return {
    isHydrated,
    isConnected,
    isLoading,
    isError,
    errorMessage,
    isEmpty,
  };
}
