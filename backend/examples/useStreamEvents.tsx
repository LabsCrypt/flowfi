// Production-ready React hook for SSE stream events
// Place this in: frontend/src/hooks/useStreamEvents.ts

import { useEffect, useState, useCallback, useRef } from 'react';

interface StreamEvent {
  type: 'created' | 'topped_up' | 'withdrawn' | 'cancelled' | 'completed';
  data: any;
  timestamp: number;
}

interface UseStreamEventsOptions {
  streamIds?: string[];
  userPublicKeys?: string[];
  subscribeToAll?: boolean;
  autoReconnect?: boolean;
  maxRetryDelay?: number;
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
  } = options;

  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const retryDelayRef = useRef(1000);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();

  const buildUrl = useCallback(() => {
    const params = new URLSearchParams();
    
    if (subscribeToAll) {
      params.append('all', 'true');
    } else {
      streamIds.forEach(id => params.append('streams', id));
      userPublicKeys.forEach(key => params.append('users', key));
    }

    const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
    return `${baseUrl}/events/subscribe?${params}`;
  }, [streamIds, userPublicKeys, subscribeToAll]);

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
        setEvents(prev => [
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

    eventSource.onerror = () => {
      setConnected(false);
      setError(new Error('SSE connection failed'));
      eventSource.close();

      if (autoReconnect) {
        setReconnecting(true);
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log(`Reconnecting in ${retryDelayRef.current}ms...`);
          connect();
          retryDelayRef.current = Math.min(
            retryDelayRef.current * 2,
            maxRetryDelay
          );
        }, retryDelayRef.current);
      }
    };
  }, [buildUrl, autoReconnect, maxRetryDelay]);

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

// Example usage in a component:
/*
import { useStreamEvents } from '@/hooks/useStreamEvents';

export function StreamDashboard({ streamId }: { streamId: string }) {
  const { events, connected, reconnecting, clearEvents } = useStreamEvents({
    streamIds: [streamId],
  });

  return (
    <div>
      <div className="flex items-center gap-2">
        <div className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
        <span>{connected ? 'Connected' : reconnecting ? 'Reconnecting...' : 'Disconnected'}</span>
        <button onClick={clearEvents}>Clear</button>
      </div>

      <div className="space-y-2">
        {events.map((event, i) => (
          <div key={i} className="border p-3 rounded">
            <div className="font-bold">{event.type}</div>
            <pre className="text-xs">{JSON.stringify(event.data, null, 2)}</pre>
            <div className="text-xs text-gray-500">
              {new Date(event.timestamp).toLocaleTimeString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
*/
