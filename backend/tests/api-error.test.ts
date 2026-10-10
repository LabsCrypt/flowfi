import { describe, it, expect } from 'vitest';
import { Prisma } from '../src/generated/prisma/index.js';
import {
  ApiError,
  badRequest,
  duplicateEntry,
  resourceNotFound,
  foreignKeyViolation,
  internal,
  fromPrismaError,
  isPrismaError,
  containsDatabaseDetails,
  sanitizeDatabaseErrorMessage,
} from '../src/lib/api-error.js';

describe('ApiError and Prisma error sanitization', () => {
  describe('ApiError class and factory functions', () => {
    it('creates ApiError with default code and optional details', () => {
      const err = new ApiError(400, 'Invalid request');
      expect(err.status).toBe(400);
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('api_error');
      expect(err.message).toBe('Invalid request');
      expect(err.details).toBeUndefined();

      const errWithDetails = new ApiError(422, 'Unprocessable', 'UNPROCESSABLE', { foo: 'bar' });
      expect(errWithDetails.details).toEqual({ foo: 'bar' });
      expect(errWithDetails.code).toBe('UNPROCESSABLE');
    });

    it('creates badRequest error', () => {
      const err = badRequest('Bad input', 'INVALID_PARAM');
      expect(err.status).toBe(400);
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('INVALID_PARAM');
      expect(err.message).toBe('Bad input');
    });

    it('creates duplicateEntry error', () => {
      const err = duplicateEntry();
      expect(err.status).toBe(409);
      expect(err.code).toBe('DUPLICATE_ENTRY');
      expect(err.message).toBe('A record with this unique value already exists.');
    });

    it('creates resourceNotFound error', () => {
      const err = resourceNotFound();
      expect(err.status).toBe(404);
      expect(err.code).toBe('RESOURCE_NOT_FOUND');
      expect(err.message).toBe('The requested record was not found.');
    });

    it('creates foreignKeyViolation error', () => {
      const err = foreignKeyViolation();
      expect(err.status).toBe(409);
      expect(err.code).toBe('FOREIGN_KEY_VIOLATION');
      expect(err.message).toBe('Related resource constraint violation.');
    });

    it('creates internal error', () => {
      const err = internal();
      expect(err.status).toBe(500);
      expect(err.code).toBe('INTERNAL_SERVER_ERROR');
      expect(err.message).toBe('A technical error occurred. Please try again later.');
    });
  });

  describe('isPrismaError', () => {
    it('returns true for PrismaClientKnownRequestError', () => {
      const err = new Prisma.PrismaClientKnownRequestError('Error', {
        code: 'P2002',
        clientVersion: '1.0',
      });
      expect(isPrismaError(err)).toBe(true);
    });

    it('returns true for PrismaClientValidationError', () => {
      const err = new Prisma.PrismaClientValidationError('Validation failed', {
        clientVersion: '1.0',
      });
      expect(isPrismaError(err)).toBe(true);
    });

    it('returns true for PrismaClientUnknownRequestError', () => {
      const err = new Prisma.PrismaClientUnknownRequestError('Unknown DB error', {
        clientVersion: '1.0',
      });
      expect(isPrismaError(err)).toBe(true);
    });

    it('returns true for duck-typed Prisma error objects', () => {
      const duckTyped = Object.assign(new Error('P2002 failed'), {
        code: 'P2002',
        clientVersion: '1.0',
      });
      expect(isPrismaError(duckTyped)).toBe(true);
    });

    it('returns false for an Error with non-matching properties', () => {
      const customErr = new Error('Custom');
      (customErr as any).code = 'CUSTOM_ERROR';
      expect(isPrismaError(customErr)).toBe(false);
    });

    it('returns false for normal Errors or non-objects', () => {
      expect(isPrismaError(new Error('normal error'))).toBe(false);
      expect(isPrismaError(null)).toBe(false);
      expect(isPrismaError(undefined)).toBe(false);
      expect(isPrismaError('string error')).toBe(false);
    });
  });

  describe('fromPrismaError', () => {
    it('maps P2002 (unique constraint) to DUPLICATE_ENTRY (409) and masks table/column metadata', () => {
      const err = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`publicKey`) table: `User`',
        {
          code: 'P2002',
          clientVersion: '1.0',
          meta: { target: ['User_publicKey_key', 'publicKey'] },
        },
      );

      const apiErr = fromPrismaError(err);
      expect(apiErr).not.toBeNull();
      expect(apiErr?.status).toBe(409);
      expect(apiErr?.code).toBe('DUPLICATE_ENTRY');
      expect(apiErr?.message).toBe('A record with this unique value already exists.');
      expect(apiErr?.message).not.toContain('User');
      expect(apiErr?.message).not.toContain('publicKey');
      expect(apiErr?.details).toBeUndefined();
    });

    it('maps P2025 and P2001 (not found) to RESOURCE_NOT_FOUND (404)', () => {
      const err2025 = new Prisma.PrismaClientKnownRequestError(
        'Record to update not found in table Stream',
        {
          code: 'P2025',
          clientVersion: '1.0',
          meta: { cause: 'Stream with id 123 does not exist' },
        },
      );

      const apiErr2025 = fromPrismaError(err2025);
      expect(apiErr2025?.status).toBe(404);
      expect(apiErr2025?.code).toBe('RESOURCE_NOT_FOUND');
      expect(apiErr2025?.message).toBe('The requested record was not found.');
      expect(apiErr2025?.message).not.toContain('Stream');

      const err2001 = new Prisma.PrismaClientKnownRequestError(
        'Record in table Stream does not exist',
        { code: 'P2001', clientVersion: '1.0' },
      );
      const apiErr2001 = fromPrismaError(err2001);
      expect(apiErr2001?.status).toBe(404);
      expect(apiErr2001?.code).toBe('RESOURCE_NOT_FOUND');
    });

    it('maps P2003 (foreign key constraint) to FOREIGN_KEY_VIOLATION (409)', () => {
      const err = new Prisma.PrismaClientKnownRequestError(
        'Foreign key constraint failed on the field: `userId` table: `Stream`',
        {
          code: 'P2003',
          clientVersion: '1.0',
          meta: { field_name: 'userId' },
        },
      );

      const apiErr = fromPrismaError(err);
      expect(apiErr?.status).toBe(409);
      expect(apiErr?.code).toBe('FOREIGN_KEY_VIOLATION');
      expect(apiErr?.message).toBe('Related resource constraint violation.');
      expect(apiErr?.message).not.toContain('userId');
      expect(apiErr?.message).not.toContain('Stream');
    });

    it('maps P2000 (value too long) to VALUE_OUT_OF_RANGE (400)', () => {
      const err = new Prisma.PrismaClientKnownRequestError('Value too long', {
        code: 'P2000',
        clientVersion: '1.0',
      });
      const apiErr = fromPrismaError(err);
      expect(apiErr?.status).toBe(400);
      expect(apiErr?.code).toBe('VALUE_OUT_OF_RANGE');
    });

    it('maps P2004 (database constraint failed) to CONSTRAINT_FAILED (400)', () => {
      const err = new Prisma.PrismaClientKnownRequestError('Constraint failed', {
        code: 'P2004',
        clientVersion: '1.0',
      });
      const apiErr = fromPrismaError(err);
      expect(apiErr?.status).toBe(400);
      expect(apiErr?.code).toBe('CONSTRAINT_FAILED');
    });

    it('maps P2005/P2006 (invalid field value) to INVALID_INPUT (400)', () => {
      const err = new Prisma.PrismaClientKnownRequestError('Invalid value', {
        code: 'P2005',
        clientVersion: '1.0',
      });
      const apiErr = fromPrismaError(err);
      expect(apiErr?.status).toBe(400);
      expect(apiErr?.code).toBe('INVALID_INPUT');
    });

    it('maps P2011/P2012/P2013 (missing required field) to MISSING_REQUIRED_FIELD (400)', () => {
      const err = new Prisma.PrismaClientKnownRequestError('Null constraint', {
        code: 'P2011',
        clientVersion: '1.0',
      });
      const apiErr = fromPrismaError(err);
      expect(apiErr?.status).toBe(400);
      expect(apiErr?.code).toBe('MISSING_REQUIRED_FIELD');
    });

    it('maps P2014/P2017 (relation violation) to RELATION_VIOLATION (409)', () => {
      const err = new Prisma.PrismaClientKnownRequestError('Relation violation', {
        code: 'P2014',
        clientVersion: '1.0',
      });
      const apiErr = fromPrismaError(err);
      expect(apiErr?.status).toBe(409);
      expect(apiErr?.code).toBe('RELATION_VIOLATION');
    });

    it('maps P2016 (query interpretation error) to INVALID_QUERY (400)', () => {
      const err = new Prisma.PrismaClientKnownRequestError('Query interpretation', {
        code: 'P2016',
        clientVersion: '1.0',
      });
      const apiErr = fromPrismaError(err);
      expect(apiErr?.status).toBe(400);
      expect(apiErr?.code).toBe('INVALID_QUERY');
    });

    it('maps P2021/P2022 (table or column does not exist) to INTERNAL_SERVER_ERROR (500)', () => {
      const err = new Prisma.PrismaClientKnownRequestError('Table does not exist', {
        code: 'P2021',
        clientVersion: '1.0',
      });
      const apiErr = fromPrismaError(err);
      expect(apiErr?.status).toBe(500);
      expect(apiErr?.code).toBe('INTERNAL_SERVER_ERROR');
      expect(apiErr?.message).toBe('A technical error occurred. Please try again later.');
    });

    it('maps other P-code request errors to DATABASE_ERROR (400)', () => {
      const err = new Prisma.PrismaClientKnownRequestError('Other db error', {
        code: 'P2099',
        clientVersion: '1.0',
      });
      const apiErr = fromPrismaError(err);
      expect(apiErr?.status).toBe(400);
      expect(apiErr?.code).toBe('DATABASE_ERROR');
      expect(apiErr?.message).toBe('A database error occurred.');
    });

    it('maps PrismaClientValidationError to VALIDATION_ERROR (400) without schema leakage', () => {
      const err = new Prisma.PrismaClientValidationError(
        'Invalid `prisma.user.findMany()` invocation: Unknown argument `badProp`',
        { clientVersion: '1.0' },
      );
      const apiErr = fromPrismaError(err);
      expect(apiErr?.status).toBe(400);
      expect(apiErr?.code).toBe('VALIDATION_ERROR');
      expect(apiErr?.message).toBe('Invalid request data.');
      expect(apiErr?.message).not.toContain('findMany');
      expect(apiErr?.message).not.toContain('badProp');
    });

    it('maps PrismaClientUnknownRequestError to INTERNAL_SERVER_ERROR (500)', () => {
      const err = new Prisma.PrismaClientUnknownRequestError(
        'SELECT * FROM "User" WHERE id = $1 - syntax error',
        { clientVersion: '1.0' },
      );
      const apiErr = fromPrismaError(err);
      expect(apiErr?.status).toBe(500);
      expect(apiErr?.code).toBe('INTERNAL_SERVER_ERROR');
      expect(apiErr?.message).toBe('A technical error occurred. Please try again later.');
      expect(apiErr?.message).not.toContain('SELECT');
      expect(apiErr?.message).not.toContain('User');
    });

    it('returns null for non-Prisma errors', () => {
      expect(fromPrismaError(new Error('generic'))).toBeNull();
      expect(fromPrismaError(null)).toBeNull();
      expect(fromPrismaError(123)).toBeNull();
    });

    it('can be invoked via ApiError.fromPrismaError static method', () => {
      const err = new Prisma.PrismaClientKnownRequestError('Conflict', {
        code: 'P2002',
        clientVersion: '1.0',
      });
      const apiErr = ApiError.fromPrismaError(err);
      expect(apiErr).toBeInstanceOf(ApiError);
      expect(apiErr?.code).toBe('DUPLICATE_ENTRY');
    });
  });

  describe('containsDatabaseDetails & sanitizeDatabaseErrorMessage', () => {
    it('detects SQL query snippets', () => {
      expect(containsDatabaseDetails('SELECT * FROM users')).toBe(true);
      expect(containsDatabaseDetails('INSERT INTO users VALUES (1)')).toBe(true);
      expect(containsDatabaseDetails('UPDATE accounts SET balance = 0')).toBe(true);
      expect(containsDatabaseDetails('DELETE FROM accounts WHERE id = 1')).toBe(true);
      expect(containsDatabaseDetails('CREATE TABLE test (id INT)')).toBe(true);
      expect(containsDatabaseDetails('DROP TABLE test')).toBe(true);
    });

    it('detects table, column, and constraint disclosures', () => {
      expect(containsDatabaseDetails('relation "streams" does not exist')).toBe(true);
      expect(containsDatabaseDetails('table "users" not found')).toBe(true);
      expect(containsDatabaseDetails('column "publicKey" is invalid')).toBe(true);
      expect(containsDatabaseDetails('foreign key mismatch')).toBe(true);
      expect(containsDatabaseDetails('syntax error at or near "SELECT"')).toBe(true);
      expect(containsDatabaseDetails('prisma query failed')).toBe(true);
    });

    it('returns false for safe messages', () => {
      expect(containsDatabaseDetails('User not found')).toBe(false);
      expect(containsDatabaseDetails('Invalid amount provided')).toBe(false);
      expect(containsDatabaseDetails('Unauthorized')).toBe(false);
    });

    it('sanitizes unsafe messages correctly according to status code', () => {
      expect(sanitizeDatabaseErrorMessage('SELECT * FROM users', 500)).toBe(
        'A technical error occurred. Please try again later.',
      );
      expect(sanitizeDatabaseErrorMessage('SELECT * FROM users', 400)).toBe(
        'A database error occurred.',
      );
      expect(sanitizeDatabaseErrorMessage('User not found', 404)).toBe('User not found');
    });
  });
});
