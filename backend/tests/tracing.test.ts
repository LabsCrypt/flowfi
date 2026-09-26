/**
 * Tests for the OpenTelemetry helper.
 *
 * `withSpan` wraps real side effects (indexer event processing, replay), so the
 * behaviour that matters is not the span data — it is that wrapping changes
 * nothing about the wrapped function. A regression here silently executes work
 * twice or turns a failure into a success.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';

const noopSpan = {
  setAttribute: vi.fn().mockReturnThis(),
  setAttributes: vi.fn().mockReturnThis(),
  setStatus: vi.fn().mockReturnThis(),
  recordException: vi.fn().mockReturnThis(),
  addEvent: vi.fn().mockReturnThis(),
  updateName: vi.fn().mockReturnThis(),
  end: vi.fn(),
  isRecording: vi.fn().mockReturnValue(true),
} as unknown as Span;

function installMockTracer() {
  const startSpan = vi.fn().mockReturnValue(noopSpan);
  const getTracer = vi.spyOn(trace, 'getTracer').mockReturnValue({
    startSpan,
  } as unknown as ReturnType<typeof trace.getTracer>);
  return { startSpan, getTracer };
}

describe('withSpan', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the wrapped value and marks the span OK', async () => {
    const { startSpan } = installMockTracer();
    const { withSpan } = await import('../src/lib/tracing.js');

    const result = await withSpan('op', { a: 1 }, async () => 'value');

    expect(result).toBe('value');
    expect(startSpan).toHaveBeenCalledWith('op', { attributes: { a: 1 } });
    expect(noopSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
  });

  it('passes the attributes through to startSpan', async () => {
    const { startSpan } = installMockTracer();
    const { withSpan } = await import('../src/lib/tracing.js');

    await withSpan('indexer.replay_dead_letter', { 'dead_letter.id': 'row-1' }, async () => 0);

    expect(startSpan).toHaveBeenCalledWith('indexer.replay_dead_letter', {
      attributes: { 'dead_letter.id': 'row-1' },
    });
  });

  it('invokes the callback exactly once on success', async () => {
    installMockTracer();
    const { withSpan } = await import('../src/lib/tracing.js');
    const fn = vi.fn().mockResolvedValue(undefined);

    await withSpan('op', {}, fn);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('propagates the error and marks the span as failed', async () => {
    installMockTracer();
    const { withSpan } = await import('../src/lib/tracing.js');
    const boom = new Error('handler threw');

    await expect(withSpan('op', {}, async () => { throw boom; })).rejects.toThrow('handler threw');

    expect(noopSpan.recordException).toHaveBeenCalledWith(boom);
    expect(noopSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
  });

  /**
   * Regression: the callback used to be re-run untraced by a catch that wrapped
   * the whole `context.with` call, so a throwing handler executed twice and its
   * error was reported as success.
   */
  it('invokes the callback exactly once when it throws, and does not swallow the error', async () => {
    installMockTracer();
    const { withSpan } = await import('../src/lib/tracing.js');
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(withSpan('op', {}, fn)).rejects.toThrow('boom');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('always ends the span', async () => {
    installMockTracer();
    const { withSpan } = await import('../src/lib/tracing.js');

    await withSpan('ok', {}, async () => 1);
    expect(noopSpan.end).toHaveBeenCalledTimes(1);

    await withSpan('bad', {}, async () => { throw new Error('x'); }).catch(() => undefined);
    expect(noopSpan.end).toHaveBeenCalledTimes(2);
  });

  it('falls back to an untraced run when the span cannot be started', async () => {
    const startSpan = vi.fn(() => {
      throw new Error('no tracer provider');
    });
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startSpan,
    } as unknown as ReturnType<typeof trace.getTracer>);

    const { withSpan } = await import('../src/lib/tracing.js');
    const fn = vi.fn().mockResolvedValue('value');

    const result = await withSpan('op', {}, fn);

    // Still returns the real result, and still runs the work exactly once.
    expect(result).toBe('value');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not recurse when the callback throws synchronously', async () => {
    installMockTracer();
    const { withSpan } = await import('../src/lib/tracing.js');
    const fn = vi.fn().mockImplementation(() => {
      throw new Error('sync boom');
    });

    await expect(withSpan('op', {}, fn as never)).rejects.toThrow('sync boom');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
