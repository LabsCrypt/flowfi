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
  closed = false;

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

  listenerCount(type: string) {
    return this.handlers.get(type)?.length ?? 0;
  }

  totalListenerCount() {
    let total = 0;
    for (const handlers of this.handlers.values()) total += handlers.length;
    return total;
  }

  /** Fire a named event as if it arrived from the server. */
  emit(type: string, data: unknown) {
    this.emitRaw(type, JSON.stringify(data));
  }

  /** Fire a named event with an already-serialized (possibly invalid) payload. */
  emitRaw(type: string, raw: string) {
    const event = { data: raw } as MessageEvent;
    for (const handler of this.handlers.get(type) ?? []) {
      handler(event);
    }
  }

  /** Fire a named event with a raw (non-JSON) string payload. */
  emitRaw(type: string, rawPayload: string) {
    const event = { data: rawPayload } as MessageEvent;
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
    this.closed = true;
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

  // ─── #1782: malformed and partial SSE frames ────────────────────────────────
  describe('malformed and partial SSE frames', () => {
    it('silently ignores malformed JSON without failing the connection', () => {
      const { result } = renderHook(() =>
        useStreamEvents({ streamIds: ['1'], autoReconnect: true }),
      );

      act(() => {
        MockEventSource.instance?.open();
        MockEventSource.instance?.emitRaw('stream.created', '{not valid json');
      });

      // Documented contract: malformed event payloads are swallowed, not
      // surfaced as a connection error.
      expect(result.current.events).toHaveLength(0);
      expect(result.current.connected).toBe(true);
      expect(result.current.error).toBeNull();
      expect(result.current.reconnecting).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(MockEventSource.instanceCount).toBe(1);
    });

    it('ignores unknown and unregistered event types', () => {
      const { result } = renderHook(() =>
        useStreamEvents({ streamIds: ['1'], autoReconnect: false }),
      );

      act(() => {
        MockEventSource.instance?.open();
        MockEventSource.instance?.emit('stream.unknown', { id: 1 });
        MockEventSource.instance?.emit('message', { id: 2 });
        MockEventSource.instance?.emit('stream.created', { id: 3 });
      });

      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0]?.type).toBe('created');
      expect(result.current.events[0]?.data).toEqual({ id: 3 });
      expect(MockEventSource.instance?.listenerCount('stream.unknown')).toBe(0);
    });

    it('processes valid events that arrive after partial and malformed frames', () => {
      const { result } = renderHook(() =>
        useStreamEvents({ streamIds: ['1'], autoReconnect: true }),
      );

      act(() => {
        const source = MockEventSource.instance;
        source?.open();
        // Truncated frame, then a frame with trailing garbage, an empty frame,
        // and whitespace only.
        source?.emitRaw('stream.created', '{"streamId": 42');
        source?.emitRaw('stream.created', '{"streamId": 42}}');
        source?.emitRaw('stream.created', '');
        source?.emitRaw('stream.created', '   ');

        // A valid frame still gets processed normally afterwards.
        source?.emit('stream.withdrawn', { amount: '10' });
        source?.emit('stream.paused', { reason: 'user' });
      });

      expect(result.current.events).toHaveLength(2);
      expect(result.current.events.map((e) => e.type)).toEqual(['paused', 'withdrawn']);
      expect(result.current.events[0]?.data).toEqual({ reason: 'user' });
      expect(result.current.events[1]?.data).toEqual({ amount: '10' });
      expect(result.current.connected).toBe(true);
      expect(result.current.error).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('recovers after a burst of malformed frames without reconnecting', () => {
      const { result } = renderHook(() =>
        useStreamEvents({ streamIds: ['1'], autoReconnect: true, maxRetryDelay: 500 }),
      );

      const first = MockEventSource.instance;

      act(() => {
        first?.open();
        for (let i = 0; i < 10; i++) {
          first?.emitRaw('stream.topped_up', '{"amount":');
        }
        first?.emit('stream.topped_up', { amount: '25' });
      });

      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0]?.data).toEqual({ amount: '25' });
      expect(result.current.connected).toBe(true);
      expect(MockEventSource.instance).toBe(first);
      expect(MockEventSource.instanceCount).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('still reports connection failures as errors after malformed frames', () => {
      const { result } = renderHook(() =>
        useStreamEvents({ streamIds: ['1'], autoReconnect: false }),
      );

      act(() => {
        const source = MockEventSource.instance;
        source?.open();
        source?.emitRaw('stream.created', 'not-json');
        source?.triggerError();
      });

      expect(result.current.events).toHaveLength(0);
      expect(result.current.connected).toBe(false);
      expect(result.current.error).toBeInstanceOf(Error);
      expect(result.current.error?.message).toBe('SSE connection failed');
    });

    it('logs a parse error when SSE payload is malformed', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() =>
        useStreamEvents({ streamIds: ['1'], autoReconnect: false }),
      );

      act(() => { MockEventSource.instance?.open(); });

      // Emit a malformed (non-JSON) payload
      act(() => {
        MockEventSource.instance?.emitRaw('stream.created', 'not-valid-json{{');
      });

      // logger.error calls console.error — verify it was called with the
      // parse-failure label and the raw payload for debugging.
      expect(consoleSpy).toHaveBeenCalled();
      const firstCall = consoleSpy.mock.calls[0] ?? [];
      expect(String(firstCall[0])).toContain('SSE payload parse failure');

      // The raw payload should appear somewhere in the logged arguments
      const loggedRaw = JSON.stringify(firstCall);
      expect(loggedRaw).toContain('not-valid-json{{');

      // The malformed event should NOT appear in the events array
      expect(result.current.events).toHaveLength(0);

      consoleSpy.mockRestore();
    });
  });

  // ─── #1783: reconnect timer and listener cleanup ────────────────────────────
  describe('reconnect cleanup', () => {
    it('clears a pending reconnect timer on unmount and never reconnects', () => {
      const streamIds = ['1'];
      const { unmount } = renderHook(() =>
        useStreamEvents({ streamIds, autoReconnect: true, maxRetryDelay: 30000 }),
      );

      const first = MockEventSource.instance!;
      act(() => { first.triggerError(); });

      expect(first.closed).toBe(true);
      expect(vi.getTimerCount()).toBe(1);

      unmount();

      expect(vi.getTimerCount()).toBe(0);

      act(() => { vi.advanceTimersByTime(60_000); });

      expect(MockEventSource.instanceCount).toBe(1);
      expect(MockEventSource.instance).toBe(first);
    });

    it('does not reconnect when unmounted mid-attempt after the timer fires', () => {
      const streamIds = ['1'];
      const { unmount } = renderHook(() =>
        useStreamEvents({ streamIds, autoReconnect: true, maxRetryDelay: 30000 }),
      );

      act(() => { MockEventSource.instance?.triggerError(); });
      act(() => { vi.advanceTimersByTime(1000); });

      const second = MockEventSource.instance!;
      expect(MockEventSource.instanceCount).toBe(2);
      expect(second.closed).toBe(false);

      unmount();

      expect(second.closed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      act(() => { vi.advanceTimersByTime(60_000); });
      expect(MockEventSource.instanceCount).toBe(2);
    });

    it('coalesces repeated error events into a single reconnect timer', () => {
      const streamIds = ['1'];
      renderHook(() =>
        useStreamEvents({ streamIds, autoReconnect: true, maxRetryDelay: 30000 }),
      );

      const first = MockEventSource.instance!;
      act(() => {
        first.open();
        first.triggerError();
        first.triggerError();
      });

      // Only one timer survives; the second error replaced the first backoff
      // timer with the next (doubled) delay instead of stacking timers.
      expect(vi.getTimerCount()).toBe(1);

      act(() => { vi.advanceTimersByTime(1999); });
      expect(MockEventSource.instanceCount).toBe(1);

      act(() => { vi.advanceTimersByTime(1); });
      expect(MockEventSource.instanceCount).toBe(2);
      expect(MockEventSource.instance).not.toBe(first);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('registers exactly one listener per event type on a reconnected source', () => {
      const streamIds = ['1'];
      renderHook(() =>
        useStreamEvents({ streamIds, autoReconnect: true, maxRetryDelay: 30000 }),
      );

      act(() => { MockEventSource.instance?.triggerError(); });
      act(() => { vi.advanceTimersByTime(1000); });

      const second = MockEventSource.instance!;
      expect(MockEventSource.instanceCount).toBe(2);

      for (const type of [
        'stream.created',
        'stream.topped_up',
        'stream.withdrawn',
        'stream.cancelled',
        'stream.completed',
        'stream.paused',
        'stream.resumed',
      ]) {
        expect(second.listenerCount(type)).toBe(1);
      }
      expect(second.totalListenerCount()).toBe(7);
    });

    it('leaves no timers behind after repeated errors and unmount', () => {
      const streamIds = ['1'];
      const { unmount } = renderHook(() =>
        useStreamEvents({ streamIds, autoReconnect: true, maxRetryDelay: 30000 }),
      );

      for (let i = 0; i < 5; i++) {
        act(() => { MockEventSource.instance?.triggerError(); });
      }

      expect(vi.getTimerCount()).toBe(1);

      unmount();

      expect(vi.getTimerCount()).toBe(0);
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(vi.getTimerCount()).toBe(0);
      expect(MockEventSource.instanceCount).toBe(1);
    });
  });
});
