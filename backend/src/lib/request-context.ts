/**
 * Request-scoped context shared by the logging and error layers (Issue #1494).
 *
 * The request id lives in a dedicated AsyncLocalStorage so the winston logger
 * and `sendApiError` can both read it without importing each other, and so
 * unit tests that mock the logger still propagate a request id into error
 * payloads.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** The request id bound to the current async execution, if any. */
export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}
