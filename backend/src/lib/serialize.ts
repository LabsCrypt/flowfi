/**
 * BigInt-safe JSON serialization for API responses (Issue #1493).
 *
 * Prisma maps `bigint` columns (stream ids, i128 amounts) to JavaScript
 * `BigInt`, which `JSON.stringify` cannot encode — it throws
 * `TypeError: Do not know how to serialize a BigInt`. Relying on a global
 * `BigInt.prototype.toJSON` patch is fragile because it only takes effect when
 * the module installing it happens to be imported, so this module provides an
 * explicit replacer plus an Express middleware that applies it to every
 * `res.json()` call, including error bodies.
 */
import type { NextFunction, Request, Response } from "express";

/**
 * `JSON.stringify` replacer that encodes `bigint` values as decimal strings.
 *
 * Strings are used rather than numbers because u64/i128 values routinely exceed
 * `Number.MAX_SAFE_INTEGER`, where a number would silently lose precision. All
 * other values are returned unchanged.
 */
export function bigIntSafeReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/**
 * `JSON.stringify` with BigInt support. Returns `undefined` (matching
 * `JSON.stringify`) for values that cannot be serialized, such as a bare
 * `undefined`.
 */
export function stringifyJson(value: unknown): string | undefined {
  return JSON.stringify(value, bigIntSafeReplacer);
}

/**
 * Express middleware that routes every `res.json()` call through
 * `stringifyJson`, so a BigInt anywhere in the response body — including inside
 * nested objects and arrays — is emitted as a decimal string instead of
 * throwing.
 *
 * Mount this on the app before the routers (and before `errorHandler`) so that
 * every controller response and every error payload is covered.
 */
export function bigIntSafeJsonMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const jsonWithBigIntSupport = (body?: unknown): Response => {
    const json = stringifyJson(body);
    if (!res.getHeader("Content-Type")) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    return res.send(json);
  };

  res.json = jsonWithBigIntSupport as Response["json"];
  next();
}
