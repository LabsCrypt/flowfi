import type { Response } from 'express';
import { Prisma } from '../generated/prisma/index.js';

/**
 * The one error envelope every API response uses:
 *
 * ```json
 * { "error": { "code": "STRING_CODE", "message": "human text", "details": ... } }
 * ```
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

/**
 * Typed application error carrying an HTTP status and optional machine-readable
 * remediation hints.
 *
 * The constructor order — `(statusCode, code, message, details)` — is identical
 * to `sendApiError`, so a call site can move between throwing and responding
 * without reordering arguments. `code` precedes `message` because `code` is what
 * clients branch on and `message` is display text.
 *
 * `errorHandler` reads `err.statusCode`, so throwing an `ApiError` from anywhere
 * in a handler chain produces the right status code without a try/catch at every
 * call site.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static fromPrismaError(err: unknown): ApiError | null {
    return fromPrismaError(err);
  }
}

/**
 * Writes the standard error envelope. Every non-2xx REST response goes through
 * this function so clients never have to branch on the shape of a failure.
 */
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
    typeof res.getHeader === 'function' ? res.getHeader('X-Request-ID') : undefined;
  if (typeof headerRequestId === 'string' && headerRequestId.length > 0) {
    error.requestId = headerRequestId;
  }
  if (details !== undefined) error.details = details;
  return res.status(statusCode).json({ error });
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new ApiError(400, code, message, details);

export const duplicateEntry = (
  message = 'A record with this unique value already exists.',
  code = 'DUPLICATE_ENTRY',
  details?: unknown,
) => new ApiError(409, code, message, details);

export const resourceNotFound = (
  message = 'The requested record was not found.',
  code = 'RESOURCE_NOT_FOUND',
  details?: unknown,
) => new ApiError(404, code, message, details);

export const foreignKeyViolation = (
  message = 'Related resource constraint violation.',
  code = 'FOREIGN_KEY_VIOLATION',
  details?: unknown,
) => new ApiError(409, code, message, details);

export const internal = (
  message = 'A technical error occurred. Please try again later.',
  code = 'INTERNAL_SERVER_ERROR',
  details?: unknown,
) => new ApiError(500, code, message, details);

/**
 * Check if an error appears to be an error originating from Prisma.
 */
export function isPrismaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  if (
    err instanceof Prisma.PrismaClientKnownRequestError ||
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientRustPanicError ||
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientValidationError
  ) {
    return true;
  }

  if (err instanceof Error) {
    return (
      err.name.startsWith('PrismaClient') ||
      ('code' in err &&
        typeof (err as any).code === 'string' &&
        (err as any).code.startsWith('P') &&
        'clientVersion' in err)
    );
  }

  return false;
}

/**
 * Maps Prisma database errors to generic, safe ApiErrors to prevent schema disclosure.
 *
 * Ensures raw SQL, table names, constraint details, and column layouts never appear
 * in client responses.
 */
export function fromPrismaError(err: unknown): ApiError | null {
  if (!err || typeof err !== 'object') {
    return null;
  }

  // Handle PrismaClientKnownRequestError
  const isKnown =
    err instanceof Prisma.PrismaClientKnownRequestError ||
    (err instanceof Error &&
      (err.name === 'PrismaClientKnownRequestError' ||
        ('code' in err &&
          typeof (err as any).code === 'string' &&
          (err as any).code.startsWith('P'))));

  if (isKnown) {
    const code = (err as any).code as string;
    switch (code) {
      case 'P2002':
        // Unique constraint violation - NEVER leak meta.target, column names, or table names
        return duplicateEntry();

      case 'P2001':
      case 'P2015':
      case 'P2018':
      case 'P2025':
        // Record not found - NEVER leak model name or search condition
        return resourceNotFound();

      case 'P2003':
        // Foreign key violation - NEVER leak meta.field_name or relation
        return foreignKeyViolation();

      case 'P2000':
        // Value too long for column
        return new ApiError(
          400,
          'VALUE_OUT_OF_RANGE',
          'A provided value exceeds the allowable limit.',
        );

      case 'P2004':
        // Database constraint failed
        return new ApiError(
          400,
          'CONSTRAINT_FAILED',
          'A database constraint was violated.',
        );

      case 'P2005':
      case 'P2006':
        // Invalid data for field type
        return new ApiError(
          400,
          'INVALID_INPUT',
          'Invalid data provided for one or more fields.',
        );

      case 'P2011':
      case 'P2012':
      case 'P2013':
        // Null or missing required field
        return new ApiError(
          400,
          'MISSING_REQUIRED_FIELD',
          'A required field was not provided.',
        );

      case 'P2014':
      case 'P2017':
        // Relation violation
        return new ApiError(
          409,
          'RELATION_VIOLATION',
          'The requested operation violates a relation constraint.',
        );

      case 'P2016':
        // Query interpretation error
        return new ApiError(400, 'INVALID_QUERY', 'Invalid query parameters.');

      case 'P2021':
      case 'P2022':
        // Table or column does not exist
        return internal();

      default:
        // Any other Prisma request errors (P2xxx, etc.)
        return new ApiError(400, 'DATABASE_ERROR', 'A database error occurred.');
    }
  }

  // Handle PrismaClientValidationError (invalid arguments, invalid invocations)
  if (
    err instanceof Prisma.PrismaClientValidationError ||
    (err instanceof Error && err.name === 'PrismaClientValidationError')
  ) {
    return new ApiError(400, 'VALIDATION_ERROR', 'Invalid request data.');
  }

  // Handle PrismaClientUnknownRequestError, RustPanic, InitializationError
  if (
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientRustPanicError ||
    err instanceof Prisma.PrismaClientInitializationError ||
    (err instanceof Error &&
      (err.name === 'PrismaClientUnknownRequestError' ||
        err.name === 'PrismaClientRustPanicError' ||
        err.name === 'PrismaClientInitializationError'))
  ) {
    return internal();
  }

  return null;
}

/**
 * Checks whether an error message contains raw SQL fragments, table names, or database internals.
 */
export function containsDatabaseDetails(message: string): boolean {
  if (!message || typeof message !== 'string') return false;

  const patterns = [
    /\bselect\b[\s\S]*?\bfrom\b/i,
    /\binsert\s+into\b/i,
    /\bupdate\b[\s\S]*?\bset\b/i,
    /\bdelete\s+from\b/i,
    /\bcreate\s+table\b/i,
    /\bdrop\s+table\b/i,
    /\balter\s+table\b/i,
    /\bprisma\b/i,
    /\btable\s+["`']?[a-zA-Z0-9_]+["`']?/i,
    /\bcolumn\s+["`']?[a-zA-Z0-9_]+["`']?/i,
    /\brelation\s+["`']?[a-zA-Z0-9_]+["`']?/i,
    /\bconstraint\s+["`']?[a-zA-Z0-9_]+["`']?/i,
    /\bforeign\s+key\b/i,
    /\bunique\s+constraint\b/i,
    /\bnull\s+constraint\b/i,
    /\bsyntax\s+error\s+at\s+or\s+near\b/i,
    /\bdatabase\s+error\b/i,
    /\bpg_\b/i,
  ];

  return patterns.some((re) => re.test(message));
}

/**
 * Sanitizes any message destined for an API response to prevent raw SQL and table name leakage.
 */
export function sanitizeDatabaseErrorMessage(message: string, statusCode = 500): string {
  if (containsDatabaseDetails(message)) {
    return statusCode === 500
      ? 'A technical error occurred. Please try again later.'
      : 'A database error occurred.';
  }
  return message;
}
