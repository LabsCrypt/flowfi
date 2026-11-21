import type { Response } from "express";

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function sendApiError(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown,
) {
  const error: ApiErrorBody = { code, message };
  // Echo the correlation id the request middleware already put on the response
  // so a client can quote one value for both the header and the body. Read it
  // back from the header rather than a second source, otherwise a route that
  // overrode X-Request-ID would report an id that does not match its own header.
  // Guarded: `res.getHeader` is absent on the stand-in responses the unit tests
  // pass in, and an error handler must never be the thing that throws.
  const headerRequestId =
    typeof res.getHeader === "function" ? res.getHeader("X-Request-ID") : undefined;
  if (typeof headerRequestId === "string" && headerRequestId.length > 0) {
    error.requestId = headerRequestId;
  }
  if (details !== undefined) error.details = details;
  return res.status(statusCode).json({ error });
}
