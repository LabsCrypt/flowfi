import { useEffect, useState, useCallback, useRef, useMemo } from 'react';

interface StreamEvent {
  type: 'created' | 'topped_up' | 'withdrawn' | 'cancelled' | 'completed' | 'paused' | 'resumed';
  data: unknown;
  timestamp: number;
}

interface UseStreamEventsOptions {
  streamIds?: string[];
  userPublicKeys?: string[];
  subscribeToAll?: boolean;
  autoReconnect?: boolean;
  maxRetryDelay?: number;
  jwtToken?: string;
}

interface UseStreamEventsReturn {
  events: StreamEvent[];
  connected: boolean;
  error: Error | null;
  reconnecting: boolean;
  clearEvents: () => void;
}

const MAX_RECONNECT_ATTEMPTS = 20;

export function useStreamEvents(
  options: UseStreamEventsOptions = {}
): UseStreamEventsReturn {
  const {
    streamIds: rawStreamIds = [],
    subscribeToAll = false,
    autoReconnect = true,
    maxRetryDelay = 30000,
    jwtToken,
  } = options;

  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const retryDelayRef = useRef(1000);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const connectRef = useRef<() => void>(() => undefined);

  const subscriptionKey = useMemo(() => {
    const streams = [...rawStreamIds].sort().join(',');
    return `${subscribeToAll ? 'all' : streams}|${jwtToken || ''}`;
  }, [rawStreamIds, subscribeToAll, jwtToken]);

  const buildUrl = useCallback(() => {
    const params = new URLSearchParams();

    if (subscribeToAll) {
      params.append('all', 'true');
    } else {
      rawStreamIds.forEach(id => params.append('streams', id));
    }

    if (jwtToken) {
      params.append('token', jwtToken);
    }

    const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    return `${baseUrl}/v1/events/subscribe?${params}`;
    // subscriptionKey captures all subscription parameters as a stable string
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionKey]);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  const connect = useCallback(() => {
    if (reconnectTimeoutRef.current !== null) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const url = buildUrl();
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setConnected(true);
      setReconnecting(false);
      setError(null);
      retryDelayRef.current = 1000;
      reconnectAttemptsRef.current = 0;
    };

    const handleEvent = (type: StreamEvent['type']) => (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setEvents((prev: StreamEvent[]) => [
          { type, data, timestamp: Date.now() },
          ...prev.slice(0, 99),
        ]);
      } catch {
        // Silently ignore malformed event messages
      }
    };

    eventSource.addEventListener('stream.created', handleEvent('created'));
    eventSource.addEventListener('stream.topped_up', handleEvent('topped_up'));
    eventSource.addEventListener('stream.withdrawn', handleEvent('withdrawn'));
    eventSource.addEventListener('stream.cancelled', handleEvent('cancelled'));
    eventSource.addEventListener('stream.completed', handleEvent('completed'));
    eventSource.addEventListener('stream.paused', handleEvent('paused'));
    eventSource.addEventListener('stream.resumed', handleEvent('resumed'));

    eventSource.onerror = () => {
      setConnected(false);
      setError(new Error('SSE connection failed'));
      eventSource.close();

      if (autoReconnect) {
        setReconnecting(true);

        if (reconnectTimeoutRef.current !== null) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }

        reconnectAttemptsRef.current += 1;

        if (reconnectAttemptsRef.current <= MAX_RECONNECT_ATTEMPTS) {
          // Cap the delay we're about to wait on, and precompute the next
          // (doubled, capped) delay up front so consecutive failures keep
          // growing the backoff even if the next attempt fails immediately.
          const delay = Math.min(retryDelayRef.current, maxRetryDelay);
          retryDelayRef.current = Math.min(retryDelayRef.current * 2, maxRetryDelay);
          reconnectTimeoutRef.current = setTimeout(() => {
            connectRef.current();
          }, delay);
        }
      }
    };
  }, [buildUrl, autoReconnect, maxRetryDelay]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current !== null) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
  }, [connect]);

  return {
    events,
    connected,
    error,
    reconnecting,
    clearEvents,
  };
}
