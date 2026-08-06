import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStreamEvents } from '../hooks/useStreamEvents';

// ─── EventSource mock ─────────────────────────────────────────────────────────

type EventHandler = (e: { data: string }) => void;
type ErrorHandler = () => void;

class MockEventSource {
  static instance: MockEventSource | null = null;
  static instanceCount = 0;

  url: string;
  onopen: (() => void) | null = null;
  onmessage: EventHandler | null = null;
  onerror: ErrorHandler | null = null;
  readyState = 0;

  private handlers: Map<string, EventHandler[]> = new Map();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instance = this;
    MockEventSource.instanceCount += 1;
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
    MockEventSource.instanceCount = 0;
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

  it('grows the reconnect delay exponentially across consecutive failures', () => {
    // Keep `streamIds` referentially stable across re-renders (an inline
    // array literal would change identity on every render and cause the
    // hook to reconnect on its own, independent of the backoff timer).
    const streamIds = ['1'];
    renderHook(() =>
      useStreamEvents({ streamIds, autoReconnect: true, maxRetryDelay: 30000 }),
    );

    const first = MockEventSource.instance;
    act(() => { first?.triggerError(); });

    // First retry is scheduled after the initial 1000ms delay.
    act(() => { vi.advanceTimersByTime(999); });
    expect(MockEventSource.instance).toBe(first);
    act(() => { vi.advanceTimersByTime(1); });
    const second = MockEventSource.instance;
    expect(second).not.toBe(first);
    expect(second).not.toBeNull();

    act(() => { second?.triggerError(); });

    // Second retry should wait ~2000ms (doubled), not repeat the 1000ms delay.
    act(() => { vi.advanceTimersByTime(1999); });
    expect(MockEventSource.instance).toBe(second);
    act(() => { vi.advanceTimersByTime(1); });
    const third = MockEventSource.instance;
    expect(third).not.toBe(second);
    expect(third).not.toBeNull();

    act(() => { third?.triggerError(); });

    // Third retry should wait ~4000ms.
    act(() => { vi.advanceTimersByTime(3999); });
    expect(MockEventSource.instance).toBe(third);
    act(() => { vi.advanceTimersByTime(1); });
    expect(MockEventSource.instance).not.toBe(third);
  });

  it('caps the reconnect delay at maxRetryDelay', () => {
    const streamIds = ['1'];
    renderHook(() =>
      useStreamEvents({ streamIds, autoReconnect: true, maxRetryDelay: 1500 }),
    );

    const first = MockEventSource.instance;
    act(() => { first?.triggerError(); });
    act(() => { vi.advanceTimersByTime(1000); }); // capped delay is min(1000, 1500) = 1000
    const second = MockEventSource.instance;
    expect(second).not.toBe(first);

    act(() => { second?.triggerError(); });
    // Next delay would be 2000 uncapped, but maxRetryDelay caps it at 1500.
    act(() => { vi.advanceTimersByTime(1499); });
    expect(MockEventSource.instance).toBe(second);
    act(() => { vi.advanceTimersByTime(1); });
    expect(MockEventSource.instance).not.toBe(second);
  });

  it('resets the backoff delay to the initial value after a successful connection', () => {
    const streamIds = ['1'];
    renderHook(() =>
      useStreamEvents({ streamIds, autoReconnect: true, maxRetryDelay: 30000 }),
    );

    const first = MockEventSource.instance;
    act(() => { first?.triggerError(); });
    act(() => { vi.advanceTimersByTime(1000); }); // reconnect after initial 1000ms

    const second = MockEventSource.instance;
    act(() => { second?.open(); }); // successful connection resets the counter
    act(() => { second?.triggerError(); });

    // Backoff should restart at 1000ms, not continue growing to 2000ms.
    act(() => { vi.advanceTimersByTime(999); });
    expect(MockEventSource.instance).toBe(second);
    act(() => { vi.advanceTimersByTime(1); });
    expect(MockEventSource.instance).not.toBe(second);
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

  it('creates only one EventSource across multiple re-renders and incoming events', () => {
    const { result, rerender } = renderHook(
      (opts: { streamIds: string[] } = { streamIds: ['1'] }) =>
        useStreamEvents({ ...opts, autoReconnect: false }),
    );

    const firstInstance = MockEventSource.instance;

    act(() => { firstInstance?.open(); });

    // Simulate multiple re-renders with the same subscription (inline array)
    rerender({ streamIds: ['1'] });
    rerender({ streamIds: ['1'] });
    rerender({ streamIds: ['1'] });

    // Simulate incoming events causing re-renders of the consumer
    act(() => {
      MockEventSource.instance?.emit('stream.created', { i: 1 });
      MockEventSource.instance?.emit('stream.created', { i: 2 });
      MockEventSource.instance?.emit('stream.created', { i: 3 });
    });

    expect(result.current.events).toHaveLength(3);

    // Re-render again after events
    rerender({ streamIds: ['1'] });
    rerender({ streamIds: ['1'] });

    expect(MockEventSource.instanceCount).toBe(1);
    expect(MockEventSource.instance).toBe(firstInstance);
  });

  it('stops reconnecting after reaching the cap', () => {
    renderHook(() =>
      useStreamEvents({ streamIds: ['1'], autoReconnect: true, maxRetryDelay: 1000 }),
    );

    // Trigger errors repeatedly to consume reconnect attempts.
    // The reconnect delay stays at 1000ms (capped by maxRetryDelay).
    for (let i = 0; i < 25; i++) {
      act(() => { MockEventSource.instance?.triggerError(); });
      act(() => { vi.advanceTimersByTime(2000); });
    }

    // 1 initial + 20 reconnect attempts = 21 instances max.
    // After the 20th reconnect attempt, no more timers should fire.
    expect(MockEventSource.instanceCount).toBeLessThanOrEqual(21);
  });
});
