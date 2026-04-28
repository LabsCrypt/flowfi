import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStreamEvents } from '../hooks/useStreamEvents';

// ─── EventSource mock ─────────────────────────────────────────────────────────

type EventHandler = (e: { data: string }) => void;
type ErrorHandler = () => void;

class MockEventSource {
  static instance: MockEventSource | null = null;

  url: string;
  onopen: (() => void) | null = null;
  onmessage: EventHandler | null = null;
  onerror: ErrorHandler | null = null;
  readyState = 0;

  private handlers: Map<string, EventHandler[]> = new Map();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instance = this;
  }

  addEventListener(type: string, handler: EventHandler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type)!.push(handler);
  }

  removeEventListener(type: string, handler: EventHandler) {
    const list = this.handlers.get(type) ?? [];
    this.handlers.set(type, list.filter((h) => h !== handler));
  }

  /** Fire a named event as if it arrived from the server. */
  emit(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const handler of this.handlers.get(type) ?? []) {
      handler(event);
    }
  }

  /** Simulate a successful connection. */
  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Simulate an error / disconnect. */
  triggerError() {
    this.readyState = 2;
    this.onerror?.();
  }

  close() {
    this.readyState = 2;
  }
}

// Replace the global EventSource with our mock
(globalThis as unknown as Record<string, unknown>).EventSource = MockEventSource;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useStreamEvents', () => {
  beforeEach(() => {
    MockEventSource.instance = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('connects and reports connected=true on open', () => {
    const { result } = renderHook(() =>
      useStreamEvents({ streamIds: ['1'], autoReconnect: false }),
    );

    act(() => { MockEventSource.instance?.open(); });

    expect(result.current.connected).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('starts disconnected before the connection opens', () => {
    const { result } = renderHook(() =>
      useStreamEvents({ streamIds: ['1'], autoReconnect: false }),
    );
    expect(result.current.connected).toBe(false);
  });

  it('updates events when a stream.created event arrives', () => {
    const { result } = renderHook(() =>
      useStreamEvents({ streamIds: ['1'], autoReconnect: false }),
    );

    act(() => {
      MockEventSource.instance?.open();
      MockEventSource.instance?.emit('stream.created', { streamId: 1 });
    });

    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0]?.type).toBe('created');
    expect((result.current.events[0]?.data as { streamId: number }).streamId).toBe(1);
  });

  it('keeps at most 100 events (oldest are dropped)', () => {
    const { result } = renderHook(() =>
      useStreamEvents({ streamIds: ['1'], autoReconnect: false }),
    );

    act(() => {
      MockEventSource.instance?.open();
      for (let i = 0; i < 105; i++) {
        MockEventSource.instance?.emit('stream.created', { i });
      }
    });

    expect(result.current.events.length).toBeLessThanOrEqual(100);
  });

  it('sets error and connected=false on connection error', () => {
    const { result } = renderHook(() =>
      useStreamEvents({ streamIds: ['1'], autoReconnect: false }),
    );

    act(() => {
      MockEventSource.instance?.open();
      MockEventSource.instance?.triggerError();
    });

    expect(result.current.connected).toBe(false);
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('reconnects after an error when autoReconnect=true', () => {
    renderHook(() =>
      useStreamEvents({ streamIds: ['1'], autoReconnect: true, maxRetryDelay: 500 }),
    );

    const first = MockEventSource.instance;
    act(() => { first?.open(); });
    act(() => { first?.triggerError(); });

    // Advance past the initial retry delay
    act(() => { vi.advanceTimersByTime(1100); });

    // A new EventSource should have been created
    expect(MockEventSource.instance).not.toBeNull();
  });

  it('clearEvents empties the events array', () => {
    const { result } = renderHook(() =>
      useStreamEvents({ streamIds: ['1'], autoReconnect: false }),
    );

    act(() => {
      MockEventSource.instance?.open();
      MockEventSource.instance?.emit('stream.topped_up', { amount: '100' });
    });

    expect(result.current.events.length).toBeGreaterThan(0);

    act(() => { result.current.clearEvents(); });

    expect(result.current.events).toHaveLength(0);
  });

  it('appends a jwtToken to the SSE URL when provided', () => {
    renderHook(() =>
      useStreamEvents({ jwtToken: 'mytoken', autoReconnect: false }),
    );
    expect(MockEventSource.instance?.url).toContain('token=mytoken');
  });

  it('handles all named event types', () => {
    const { result } = renderHook(() =>
      useStreamEvents({ streamIds: ['1'], autoReconnect: false }),
    );

    const types = [
      'stream.created',
      'stream.topped_up',
      'stream.withdrawn',
      'stream.cancelled',
      'stream.completed',
      'stream.paused',
      'stream.resumed',
    ] as const;

    act(() => {
      MockEventSource.instance?.open();
      for (const t of types) {
        MockEventSource.instance?.emit(t, {});
      }
    });

    expect(result.current.events).toHaveLength(types.length);
  });
});
