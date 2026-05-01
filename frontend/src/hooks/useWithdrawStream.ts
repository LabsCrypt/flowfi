"use client";

import { useCallback, useState } from "react";
import { withdrawStream, type WithdrawStreamResponse } from "@/lib/api/streams";

interface UseWithdrawStreamResult {
  withdraw: (id: string) => Promise<WithdrawStreamResponse>;
  error: Error | null;
  isPending: boolean;
}

export function useWithdrawStream(): UseWithdrawStreamResult {
  const [error, setError] = useState<Error | null>(null);
  const [isPending, setIsPending] = useState(false);

  const withdraw = useCallback(async (id: string) => {
    setError(null);
    setIsPending(true);

    try {
      return await withdrawStream(id);
    } catch (err) {
      const nextError = err instanceof Error ? err : new Error("Failed to withdraw stream.");
      setError(nextError);
      throw nextError;
    } finally {
      setIsPending(false);
    }
  }, []);

  return { withdraw, error, isPending };
}
