import { useEffect, useState, useCallback, useRef } from 'react';

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

export function useStreamEvents(
  options: UseStreamEventsOptions = {}
): UseStreamEventsReturn {
  const {
    streamIds = [],
    userPublicKeys = [],
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
  const connectRef = useRef<() => void>(() => undefined);

  const buildUrl = useCallback(() => {
    const params = new URLSearchParams();
    
    if (subscribeToAll) {
      params.append('all', 'true');
    } else {
      streamIds.forEach(id => params.append('streams', id));
      userPublicKeys.forEach(key => params.append('users', key));
    }

    // Add JWT token to query string for authentication
    // (EventSource doesn't support custom headers in browser)
    if (jwtToken) {
      params.append('token', jwtToken);
    }

    const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    return `${baseUrl}/v1/events/subscribe?${params}`;
  }, [streamIds, userPublicKeys, subscribeToAll, jwtToken]);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  const connect = useCallback(() => {
    const url = buildUrl();
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onopen = () => {
      setConnected(true);
      setReconnecting(false);
      setError(null);
      retryDelayRef.current = 1000; // Reset retry delay
    };

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'connected') {
          console.log('SSE connected:', data.clientId);
        }
      } catch (err) {
        console.error('Failed to parse SSE message:', err);
      }
    };

    const handleEvent = (type: StreamEvent['type']) => (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        setEvents((prev: StreamEvent[]) => [
          { type, data, timestamp: Date.now() },
          ...prev.slice(0, 99), // Keep last 100 events
        ]);
      } catch (err) {
        console.error(`Failed to parse ${type} event:`, err);
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
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log(`Reconnecting in ${retryDelayRef.current}ms...`);
          connectRef.current();
          retryDelayRef.current = Math.min(
            retryDelayRef.current * 2,
            maxRetryDelay
          );
        }, retryDelayRef.current);
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
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
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
