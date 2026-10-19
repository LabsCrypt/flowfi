import { describe, it, expect, vi, beforeEach } from 'vitest';
import { errorHandler } from '../src/middleware/error.middleware.js';
import { ZodError } from 'zod';
import { Prisma } from '../src/generated/prisma/index.js';
import logger from '../src/logger.js';
import { ApiError } from '../src/lib/api-error.js';
import type { Request, Response, NextFunction } from 'express';

describe('Error Middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    req = {};
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    next = vi.fn();
  });

  it('should handle ZodError', () => {
    const error = new ZodError([{ path: ['field'], message: 'invalid', code: 'custom' }]);
    errorHandler(error, req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    }));
  });

  it('should handle Prisma P2002 error with sanitized DUPLICATE_ENTRY code and without schema leak', () => {
    const loggerSpy = vi.spyOn(logger, 'error');
    const error = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`email`)',
      { code: 'P2002', clientVersion: '1.0', meta: { target: ['email', 'User_email_key'] } },
    );

    errorHandler(error, req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'DUPLICATE_ENTRY',
        message: 'A record with this unique value already exists.',
      },
    });

    // Verify response body never leaks column name or constraint
    const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const jsonStr = JSON.stringify(jsonCall);
    expect(jsonStr).not.toContain('email');
    expect(jsonStr).not.toContain('User_email_key');

    // Verify full error context is preserved in logger
    expect(loggerSpy).toHaveBeenCalledWith('Unhandled error:', error);
  });

  it('should handle Prisma P2025 error with sanitized RESOURCE_NOT_FOUND code', () => {
    const error = new Prisma.PrismaClientKnownRequestError(
      'An operation failed because it depends on one or more records that were required but not found. Record of type User was not found.',
      { code: 'P2025', clientVersion: '1.0', meta: { cause: 'Record to update not found.' } },
    );

    errorHandler(error, req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'The requested record was not found.',
      },
    });

    const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const jsonStr = JSON.stringify(jsonCall);
    expect(jsonStr).not.toContain('User');
    expect(jsonStr).not.toContain('Record to update');
  });

  it('should handle Prisma P2003 foreign key error without leaking field or relation names', () => {
    const error = new Prisma.PrismaClientKnownRequestError(
      'Foreign key constraint failed on the field: `userId` table: `users`',
      { code: 'P2003', clientVersion: '1.0', meta: { field_name: 'userId' } },
    );

    errorHandler(error, req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'FOREIGN_KEY_VIOLATION',
        message: 'Related resource constraint violation.',
      },
    });

    const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const jsonStr = JSON.stringify(jsonCall);
    expect(jsonStr).not.toContain('userId');
    expect(jsonStr).not.toContain('users');
  });

  it('should handle Prisma P2000 value too long error', () => {
    const error = new Prisma.PrismaClientKnownRequestError(
      "The provided value for the column is too long for the column's type. Column: title",
      { code: 'P2000', clientVersion: '1.0', meta: { column_name: 'title' } },
    );

    errorHandler(error, req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'VALUE_OUT_OF_RANGE',
        message: 'A provided value exceeds the allowable limit.',
      },
    });

    const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(JSON.stringify(jsonCall)).not.toContain('title');
  });

  it('should handle PrismaClientValidationError without exposing model schema', () => {
    const error = new Prisma.PrismaClientValidationError(
      'Invalid `prisma.user.create()` invocation: Unknown argument `unknownField`. Did you mean `publicKey`?',
      { clientVersion: '1.0' },
    );

    errorHandler(error, req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data.',
      },
    });

    const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const jsonStr = JSON.stringify(jsonCall);
    expect(jsonStr).not.toContain('unknownField');
    expect(jsonStr).not.toContain('publicKey');
    expect(jsonStr).not.toContain('prisma.user');
  });

  it('should handle PrismaClientUnknownRequestError without leaking raw SQL', () => {
    const error = new Prisma.PrismaClientUnknownRequestError(
      'SELECT * FROM "users" WHERE id = $1 failed: syntax error at or near "SELECT"',
      { clientVersion: '1.0' },
    );

    errorHandler(error, req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'A technical error occurred. Please try again later.',
      },
    });

    const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const jsonStr = JSON.stringify(jsonCall);
    expect(jsonStr).not.toContain('SELECT');
    expect(jsonStr).not.toContain('users');
  });

  it('should sanitize generic 4xx error messages containing raw SQL or table names', () => {
    const error = new Error('Database error in table "users": syntax error at or near "SELECT"');
    (error as any).status = 400;

    errorHandler(error, req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(400);
    const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const jsonStr = JSON.stringify(jsonCall);
    expect(jsonStr).not.toContain('SELECT');
    expect(jsonStr).not.toContain('users');
    expect(jsonCall.error.message).toBe('A database error occurred.');
  });

  it('should handle generic error', () => {
    const error = new Error('Generic error');
    errorHandler(error, req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'A technical error occurred. Please try again later.',
      },
    });
  });

  it('should handle ApiError instances and preserve code/details', () => {
    const error = new ApiError(403, 'Forbidden action', 'FORBIDDEN_ACTION', { reason: 'denied' });
    errorHandler(error, req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'FORBIDDEN_ACTION',
        message: 'Forbidden action',
        details: { reason: 'denied' },
      },
    });
  });

  it('should sanitize ApiError instances if message contains raw database details', () => {
    const error = new ApiError(400, 'Error in table "users": syntax error at or near "SELECT"', 'BAD_INPUT');
    errorHandler(error, req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(400);
    const jsonCall = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(jsonCall.error.message).toBe('A database error occurred.');
    expect(jsonCall.error.code).toBe('BAD_INPUT');
  });

  it('should delegate to next when headers were already sent', () => {
    const error = new Error('Stream failed after headers');
    res.headersSent = true;

    errorHandler(error, req as Request, res as Response, next);

    expect(next).toHaveBeenCalledWith(error);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

