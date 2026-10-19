import { z } from 'zod';
import { parseStreamId } from '../lib/stream-id.js';

/** Soroban `i128` upper bound (2^127 - 1). Values above this overflow the
 * on-chain type and the Postgres i128 columns, so they must never pass
 * request validation. */
export const MAX_I128 = BigInt('170141183460469231731687303715884105727');

function isAtMostI128(val: string): boolean {
  try {
    return BigInt(val) <= MAX_I128;
  } catch {
    return true;
  }
}

export const createStreamSchema = z.object({
  streamId: z
    .union([z.number(), z.string(), z.bigint()])
    .transform((v, ctx) => {
      const parsed = parseStreamId(v);
      if (parsed === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'streamId must be a non-negative integer',
        });
        return z.NEVER;
      }
      return parsed;
    }),
  sender: z.string().min(1, 'Sender address is required'),
  recipient: z.string().min(1, 'Recipient address is required'),
  tokenAddress: z.string().min(1, 'Token address is required'),
  ratePerSecond: z
    .string()
    .regex(/^\d+$/, 'Rate must be a positive integer as string')
    .refine(isAtMostI128, { message: 'Rate exceeds maximum allowed value' }),
  depositedAmount: z
    .string()
    .regex(/^\d+$/, 'Amount must be a positive integer as string')
    .refine(isAtMostI128, { message: 'Amount exceeds maximum allowed value' }),
  startTime: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(v => parseInt(v))]),
});

export type CreateStreamInput = z.infer<typeof createStreamSchema>;

export interface PaginationOptions {
  /** Applied when `limit` is absent or empty. Defaults to 20. */
  defaultLimit?: number;
  /** Hard cap; a larger `limit` is clamped to this. Defaults to 100. */
  maxLimit?: number;
}

export type PaginationResult =
  | { ok: true; page: number; limit: number; offset: number }
  | { ok: false; message: string };

const POSITIVE_INT = /^\d+$/;

/**
 * Validate `limit` / `page` / `offset` query parameters for list endpoints
 * (issue #1644).
 *
 * Previously each controller re-implemented this with `parseInt`, which let
 * `?limit=-5` reach Prisma as `take: -5` and let `?limit=999999` pull an
 * unbounded page into memory. The rules now are:
 *
 * - absent/empty `limit` → `defaultLimit`
 * - `limit` must be a positive integer, and is capped at `maxLimit`
 * - absent/empty `page` → `1`; `page` must be a positive integer
 * - an explicit non-negative `offset` wins; otherwise `offset = (page - 1) * limit`
 * - anything else (non-numeric, negative, zero, array values) → `ok: false`
 *
 * Callers translate `ok: false` into a 400 rather than silently defaulting,
 * so a malformed page request is visible to the client.
 */
export function parsePagination(
  query: Record<string, unknown> | undefined,
  options: PaginationOptions = {},
): PaginationResult {
  const defaultLimit = options.defaultLimit ?? 20;
  const maxLimit = options.maxLimit ?? 100;
  const { limit: rawLimit, page: rawPage, offset: rawOffset } = query ?? {};

  const isBlank = (value: unknown) => value === undefined || value === null || value === "";
  const isPositiveInt = (value: unknown): value is string =>
    typeof value === "string" && POSITIVE_INT.test(value);

  let limit = defaultLimit;
  if (!isBlank(rawLimit)) {
    if (!isPositiveInt(rawLimit) || Number.parseInt(rawLimit, 10) < 1) {
      return { ok: false, message: "limit must be a positive integer" };
    }
    limit = Math.min(Number.parseInt(rawLimit, 10), maxLimit);
  }

  let page = 1;
  if (!isBlank(rawPage)) {
    if (!isPositiveInt(rawPage) || Number.parseInt(rawPage, 10) < 1) {
      return { ok: false, message: "page must be a positive integer" };
    }
    page = Number.parseInt(rawPage, 10);
  }

  let offset = Math.max(0, (page - 1) * limit);
  if (!isBlank(rawOffset)) {
    if (!isPositiveInt(rawOffset)) {
      return { ok: false, message: "offset must be a non-negative integer" };
    }
    offset = Number.parseInt(rawOffset, 10);
  }

  return { ok: true, page, limit, offset };
}
