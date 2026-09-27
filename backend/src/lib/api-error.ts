/**
 * Typed application error carrying an HTTP status and optional machine-readable
 * remediation hints.
 *
 * `errorHandler` reads `err.status`, so throwing an `ApiError` from anywhere in
 * a handler chain produces the right status code without a try/catch at every
 * call site. The optional `code` lets clients branch on the failure class rather
 * than string-matching a message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    code = 'api_error',
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const badRequest = (message: string, code?: string, details?: Record<string, unknown>) =>
  new ApiError(400, message, code, details);
