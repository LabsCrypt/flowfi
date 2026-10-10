import type { Response } from "express";
import { getRequestId } from "../lib/request-context.js";

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  /**
   * Correlation id for the failing request (Issue #1494). Clients can quote it
   * to support engineers, who can then find the matching winston log lines.
   */
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
  if (details !== undefined) error.details = details;
  const requestId = getRequestId();
  if (requestId) error.requestId = requestId;
  return res.status(statusCode).json({ error });
}
