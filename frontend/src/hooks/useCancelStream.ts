"use client";

import { useCallback, useState } from "react";
import { cancelStream } from "@/lib/api/streams";

interface UseCancelStreamResult<TStream> {
  cancel: (id: string) => Promise<TStream>;
  error: Error | null;
  isPending: boolean;
}

export function useCancelStream<TStream = unknown>(): UseCancelStreamResult<TStream> {
  const [error, setError] = useState<Error | null>(null);
  const [isPending, setIsPending] = useState(false);

  const cancel = useCallback(async (id: string) => {
    setError(null);
    setIsPending(true);

    try {
      return await cancelStream<TStream>(id);
    } catch (err) {
      const nextError = err instanceof Error ? err : new Error("Failed to cancel stream.");
      setError(nextError);
      throw nextError;
    } finally {
      setIsPending(false);
    }
  }, []);

  return { cancel, error, isPending };
}
