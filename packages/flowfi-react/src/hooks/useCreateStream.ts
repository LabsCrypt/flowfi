'use client';

import { useCallback, useState } from 'react';
import type { CreateStreamParams, CreateStreamState } from '../types';
import { useFlowFiConfig } from '../components/FlowFiProvider';

export interface UseCreateStreamOptions {
  /** Simulates fees & tx size before signing. Return the tx envelope. */
  simulate?: (params: CreateStreamParams, config: ReturnType<typeof useFlowFiConfig>) => Promise<unknown>;
  /** Prompts the wallet to sign. Return the signed XDR. */
  sign?: (envelope: unknown) => Promise<string>;
  /** Broadcasts the signed XDR. Return the tx hash. */
  broadcast?: (signedXdr: string) => Promise<string>;
  /** Waits for indexer confirmation. */
  confirm?: (txHash: string) => Promise<void>;
}

export interface UseCreateStreamResult {
  state: CreateStreamState;
  txHash: string | null;
  error: Error | null;
  submit: (params: CreateStreamParams) => Promise<string | null>;
  reset: () => void;
}

export function useCreateStream(options: UseCreateStreamOptions = {}): UseCreateStreamResult {
  const config = useFlowFiConfig();
  const [state, setState] = useState<CreateStreamState>('idle');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const reset = useCallback(() => {
    setState('idle');
    setTxHash(null);
    setError(null);
  }, []);

  const submit = useCallback(
    async (params: CreateStreamParams): Promise<string | null> => {
      setError(null);
      setTxHash(null);
      try {
        setState('simulating');
        const envelope = options.simulate
          ? await options.simulate(params, config)
          : { params };

        setState('signing');
        const signedXdr = options.sign
          ? await options.sign(envelope)
          : typeof envelope === 'string'
            ? envelope
            : JSON.stringify(envelope);

        setState('broadcasting');
        const hash = options.broadcast
          ? await options.broadcast(signedXdr)
          : `mock-${Date.now().toString(36)}`;

        setTxHash(hash);

        if (options.confirm) await options.confirm(hash);
        setState('confirmed');
        return hash;
      } catch (err) {
        setState('error');
        setError(err instanceof Error ? err : new Error('Transaction failed'));
        return null;
      }
    },
    [config, options],
  );

  return { state, txHash, error, submit, reset };
}
