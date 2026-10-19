import {
  trace,
  context,
  SpanStatusCode,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

/**
 * Thin wrapper over the OpenTelemetry API.
 *
 * The SDK is initialised in `tracing.ts` (imported for its side effects from
 * `index.ts` before anything else) and the Node auto-instrumentations register
 * the express/http/pg spans automatically. This module adds the two things the
 * auto-instrumentation cannot infer:
 *
 *  - stable span names for domain operations (indexer batches, RPC calls), and
 *  - a no-op span fallback so importing instrumentation from unit tests — or
 *    running with `OTEL_SDK_DISABLED=true` — never throws and never records.
 */

const TRACER_NAME = 'flowfi-backend';

/**
 * Resolve the tracer on every call rather than caching one at module load.
 *
 * `trace.getTracer` returns a proxy tracer when no provider is registered yet
 * and upgrades itself once the SDK installs one, but caching at import time
 * still pins whichever provider happened to exist then. Resolving per call
 * keeps the helper usable when the SDK is disabled or initialised after this
 * module, and keeps it testable.
 */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/** Stand-in span used when the API has no recording provider installed. */
const NOOP_SPAN = {
  setAttribute: () => NOOP_SPAN,
  setAttributes: () => NOOP_SPAN,
  addEvent: () => NOOP_SPAN,
  setStatus: () => NOOP_SPAN,
  recordException: () => undefined,
  updateName: () => NOOP_SPAN,
  end: () => undefined,
  isRecording: () => false,
  spanContext: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 }),
  addLink: () => NOOP_SPAN,
  addLinks: () => NOOP_SPAN,
} as unknown as Span;

/**
 * Run `fn` inside an active span.
 *
 * Tracing must never change behaviour, which means two invariants:
 *
 *  1. `fn` is invoked **exactly once**. An earlier version wrapped the whole
 *     `context.with(...)` call in a catch and re-ran `fn` on any error, so a
 *     handler that threw was executed a second time untraced — the error
 *     vanished and the side effect happened twice.
 *  2. An error raised by `fn` propagates to the caller untouched, so callers
 *     can still react to it (replay failure, quarantine, rollback).
 *
 * The untraced fallback is therefore only used when the span could not be
 * started or the context could not be entered at all — i.e. before `fn` ran.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  let span: Span;
  let spanContext: Context;
  try {
    span = getTracer().startSpan(name, { attributes });
    spanContext = trace.setSpan(context.active(), span);
  } catch {
    // Could not even start a span: run untraced rather than fail the request.
    return fn(NOOP_SPAN);
  }

  let fnRan = false;
  try {
    return await context.with(spanContext, async () => {
      fnRan = true;
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  } catch (err) {
    if (fnRan) {
      // The error came from `fn` (or from unwinding the context). Propagate it.
      throw err;
    }
    // The context could not be entered, so `fn` never ran. End the orphaned
    // span and run once, untraced.
    span.end();
    return fn(NOOP_SPAN);
  }
}

/** Record an exception on the currently-active span, if there is one. */
export function recordSpanError(err: unknown, attributes?: Record<string, string | number | boolean>): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.recordException(err as Error);
  span.setStatus({ code: SpanStatusCode.ERROR });
  if (attributes) span.setAttributes(attributes);
}
