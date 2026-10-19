import { Prisma } from '../generated/prisma/index.js';

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

  get statusCode(): number {
    return this.status;
  }

  static fromPrismaError(err: unknown): ApiError | null {
    return fromPrismaError(err);
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: Record<string, unknown>) =>
  new ApiError(400, message, code, details);

export const duplicateEntry = (
  message = 'A record with this unique value already exists.',
  code = 'DUPLICATE_ENTRY',
  details?: Record<string, unknown>,
) => new ApiError(409, message, code, details);

export const resourceNotFound = (
  message = 'The requested record was not found.',
  code = 'RESOURCE_NOT_FOUND',
  details?: Record<string, unknown>,
) => new ApiError(404, message, code, details);

export const foreignKeyViolation = (
  message = 'Related resource constraint violation.',
  code = 'FOREIGN_KEY_VIOLATION',
  details?: Record<string, unknown>,
) => new ApiError(409, message, code, details);

export const internal = (
  message = 'A technical error occurred. Please try again later.',
  code = 'INTERNAL_SERVER_ERROR',
  details?: Record<string, unknown>,
) => new ApiError(500, message, code, details);

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
        return new ApiError(
          409,
          'A record with this unique value already exists.',
          'DUPLICATE_ENTRY',
        );

      case 'P2001':
      case 'P2015':
      case 'P2018':
      case 'P2025':
        // Record not found - NEVER leak model name or search condition
        return new ApiError(
          404,
          'The requested record was not found.',
          'RESOURCE_NOT_FOUND',
        );

      case 'P2003':
        // Foreign key violation - NEVER leak meta.field_name or relation
        return new ApiError(
          409,
          'Related resource constraint violation.',
          'FOREIGN_KEY_VIOLATION',
        );

      case 'P2000':
        // Value too long for column
        return new ApiError(
          400,
          'A provided value exceeds the allowable limit.',
          'VALUE_OUT_OF_RANGE',
        );

      case 'P2004':
        // Database constraint failed
        return new ApiError(
          400,
          'A database constraint was violated.',
          'CONSTRAINT_FAILED',
        );

      case 'P2005':
      case 'P2006':
        // Invalid data for field type
        return new ApiError(
          400,
          'Invalid data provided for one or more fields.',
          'INVALID_INPUT',
        );

      case 'P2011':
      case 'P2012':
      case 'P2013':
        // Null or missing required field
        return new ApiError(
          400,
          'A required field was not provided.',
          'MISSING_REQUIRED_FIELD',
        );

      case 'P2014':
      case 'P2017':
        // Relation violation
        return new ApiError(
          409,
          'The requested operation violates a relation constraint.',
          'RELATION_VIOLATION',
        );

      case 'P2016':
        // Query interpretation error
        return new ApiError(
          400,
          'Invalid query parameters.',
          'INVALID_QUERY',
        );

      case 'P2021':
      case 'P2022':
        // Table or column does not exist
        return new ApiError(
          500,
          'A technical error occurred. Please try again later.',
          'INTERNAL_SERVER_ERROR',
        );

      default:
        // Any other Prisma request errors (P2xxx, etc.)
        return new ApiError(
          400,
          'A database error occurred.',
          'DATABASE_ERROR',
        );
    }
  }

  // Handle PrismaClientValidationError (invalid arguments, invalid invocations)
  if (
    err instanceof Prisma.PrismaClientValidationError ||
    (err instanceof Error && err.name === 'PrismaClientValidationError')
  ) {
    return new ApiError(400, 'Invalid request data.', 'VALIDATION_ERROR');
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
    return new ApiError(
      500,
      'A technical error occurred. Please try again later.',
      'INTERNAL_SERVER_ERROR',
    );
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
