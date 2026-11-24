'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import {
  type CachedStream,
  type OptimisticMutation,
  getCachedStreams,
  getOptimisticMutations,
  putCachedStreams,
  putOptimisticMutation,
  deleteOptimisticMutation,
} from '@/lib/storage/stream-cache';

export interface StreamContextValue {
  /** Effective streams: cached canonical state + pending optimistic patches. */
  streams: CachedStream[];
  mutations: OptimisticMutation[];
  /** True once the IndexedDB hydration effect has run. */
  isHydrated: boolean;
  /** True while a background network refresh is in flight. */
  isLoading: boolean;
  error: Error | null;
  getStream: (id: string) => CachedStream | undefined;
  upsertStreams: (streams: CachedStream[]) => void;
  applyOptimistic: (mutation: OptimisticMutation) => Promise<void>;
  resolveMutation: (mutationId: string) => Promise<void>;
  rollbackMutation: (mutationId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

interface State {
  streams: Record<string, CachedStream>;
  mutations: OptimisticMutation[];
  isHydrated: boolean;
  isLoading: boolean;
  error: Error | null;
}

type Action =
  | { type: 'hydrate'; streams: CachedStream[]; mutations: OptimisticMutation[] }
  | { type: 'upsertStreams'; streams: CachedStream[] }
  | { type: 'addMutation'; mutation: OptimisticMutation }
  | { type: 'removeMutation'; id: string }
  | { type: 'setLoading'; value: boolean }
  | { type: 'setError'; error: Error | null };

const initialState: State = {
  streams: {},
  mutations: [],
  isHydrated: false,
  isLoading: false,
  error: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'hydrate': {
      const streams: Record<string, CachedStream> = {};
      for (const s of action.streams) streams[s.id] = s;
      return {
        ...state,
        streams,
        // Only keep pending mutations across reloads; confirmed/failed are stale.
        mutations: action.mutations.filter((m) => m.status === 'pending'),
        isHydrated: true,
        isLoading: false,
      };
    }
    case 'upsertStreams': {
      const next = { ...state.streams };
      for (const s of action.streams) next[s.id] = s;
      return { ...state, streams: next, isLoading: false };
    }
    case 'addMutation':
      return { ...state, mutations: [...state.mutations, action.mutation] };
    case 'removeMutation':
      return { ...state, mutations: state.mutations.filter((m) => m.id !== action.id) };
    case 'setLoading':
      return { ...state, isLoading: action.value };
    case 'setError':
      return { ...state, error: action.error };
    default:
      return state;
  }
}

const StreamContext = createContext<StreamContextValue | null>(null);

export interface StreamProviderProps {
  children: ReactNode;
  /**
   * Optional background fetcher that returns canonical streams from the API /
   * indexer. Called once on mount and then on every `syncInterval` tick.
   */
  fetcher?: () => Promise<CachedStream[]>;
  /** Polling interval for reconciliation in ms. 0 disables periodic sync. */
  syncInterval?: number;
}

export function StreamProvider({ children, fetcher, syncInterval = 0 }: StreamProviderProps) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // 1. Hydrate instantly from IndexedDB (target: < 15ms).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let cached: CachedStream[] = [];
      let mutations: OptimisticMutation[] = [];
      try {
        [cached, mutations] = await Promise.all([
          getCachedStreams(),
          getOptimisticMutations(),
        ]);
      } catch {
        // Missing IndexedDB is not fatal — the app still works online.
      }
      if (cancelled) return;
      dispatch({ type: 'hydrate', streams: cached, mutations });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 2. Background reconciliation against the network.
  const refresh = useCallback(async () => {
    if (!fetcher) return;
    dispatch({ type: 'setLoading', value: true });
    try {
      const fresh = await fetcher();
      dispatch({ type: 'upsertStreams', streams: fresh });
      dispatch({ type: 'setError', error: null });
      // Persist so the next cold start is instant.
      void putCachedStreams(fresh).catch(() => undefined);
    } catch (err) {
      dispatch({
        type: 'setError',
        error: err instanceof Error ? err : new Error('Failed to refresh streams'),
      });
    } finally {
      dispatch({ type: 'setLoading', value: false });
    }
  }, [fetcher]);

  useEffect(() => {
    if (!fetcher) return undefined;
    void refresh();
    if (syncInterval > 0) {
      const id = setInterval(() => void refresh(), syncInterval);
      return () => clearInterval(id);
    }
    return undefined;
  }, [fetcher, refresh, syncInterval]);

  const upsertStreams = useCallback((streams: CachedStream[]) => {
    dispatch({ type: 'upsertStreams', streams });
  }, []);

  const applyOptimistic = useCallback(
    async (mutation: OptimisticMutation) => {
      dispatch({ type: 'addMutation', mutation });
      await putOptimisticMutation(mutation).catch(() => undefined);
    },
    [],
  );

  const resolveMutation = useCallback(async (mutationId: string) => {
    dispatch({ type: 'removeMutation', id: mutationId });
    await deleteOptimisticMutation(mutationId).catch(() => undefined);
  }, []);

  const rollbackMutation = useCallback(async (mutationId: string) => {
    dispatch({ type: 'removeMutation', id: mutationId });
    await deleteOptimisticMutation(mutationId).catch(() => undefined);
  }, []);

  // 3. Effective streams = canonical map with pending patches layered on top.
  const effectiveStreams = useMemo(() => {
    const map = new Map<string, CachedStream>();
    for (const s of Object.values(state.streams)) map.set(s.id, s);
    for (const m of state.mutations) {
      if (m.status !== 'pending') continue;
      const base = map.get(m.streamId);
      if (!base) continue;
      map.set(m.streamId, { ...base, ...m.patch });
    }
    return Array.from(map.values());
  }, [state.streams, state.mutations]);

  const getStream = useCallback(
    (id: string) => effectiveStreams.find((s) => s.id === id),
    [effectiveStreams],
  );

  const value = useMemo<StreamContextValue>(
    () => ({
      streams: effectiveStreams,
      mutations: state.mutations,
      isHydrated: state.isHydrated,
      isLoading: state.isLoading,
      error: state.error,
      getStream,
      upsertStreams,
      applyOptimistic,
      resolveMutation,
      rollbackMutation,
      refresh,
    }),
    [
      effectiveStreams,
      state.mutations,
      state.isHydrated,
      state.isLoading,
      state.error,
      getStream,
      upsertStreams,
      applyOptimistic,
      resolveMutation,
      rollbackMutation,
      refresh,
    ],
  );

  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>;
}

export function useStreamContext(): StreamContextValue {
  const ctx = useContext(StreamContext);
  if (!ctx) throw new Error('useStreamContext must be used inside a <StreamProvider>');
  return ctx;
}
