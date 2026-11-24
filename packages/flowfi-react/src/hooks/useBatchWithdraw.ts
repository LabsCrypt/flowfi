'use client';

import { useCallback, useState } from 'react';

export interface UseBatchWithdrawOptions {
  /** Estimates gas for the full batch. Return the total fee in stroops. */
  estimate?: (streamIds: string[]) => Promise<bigint>;
  /** Broadcasts a single batch transaction. Return the tx hash. */
  dispatch?: (streamIds: string[]) => Promise<string>;
}

export interface UseBatchWithdrawResult {
  selected: string[];
  isSubmitting: boolean;
  feeEstimate: bigint | null;
  txHash: string | null;
  error: Error | null;
  toggle: (streamId: string) => void;
  selectAll: (streamIds: string[]) => void;
  clear: () => void;
  estimateFee: () => Promise<void>;
  submit: () => Promise<string | null>;
}

export function useBatchWithdraw(
  options: UseBatchWithdrawOptions = {},
): UseBatchWithdrawResult {
  const [selected, setSelected] = useState<string[]>([]);
  const [isSubmitting, setSubmitting] = useState(false);
  const [feeEstimate, setFeeEstimate] = useState<bigint | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const selectAll = useCallback((ids: string[]) => setSelected(ids), []);
  const clear = useCallback(() => setSelected([]), []);

  const estimateFee = useCallback(async () => {
    if (!options.estimate || selected.length === 0) return;
    try {
      setFeeEstimate(await options.estimate(selected));
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Fee estimation failed'));
    }
  }, [options, selected]);

  const submit = useCallback(async () => {
    if (selected.length === 0) return null;
    setSubmitting(true);
    setError(null);
    try {
      const hash = options.dispatch
        ? await options.dispatch(selected)
        : `mock-batch-${Date.now().toString(36)}`;
      setTxHash(hash);
      setSelected([]);
      return hash;
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Batch withdraw failed'));
      return null;
    } finally {
      setSubmitting(false);
    }
  }, [options, selected]);

  return {
    selected,
    isSubmitting,
    feeEstimate,
    txHash,
    error,
    toggle,
    selectAll,
    clear,
    estimateFee,
    submit,
  };
}
