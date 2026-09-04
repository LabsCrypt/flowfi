import type { Request, Response, NextFunction } from 'express';
import { Prisma } from '../generated/prisma/index.js';
import { ZodError, type ZodIssue } from 'zod';
import logger from '../logger.js';
import { ApiError, sendApiError } from '../types/api-error.js';

/**
 * Global error handler middleware
 */
export const errorHandler = (
    err: unknown,
    req: Request,
    res: Response,
    next: NextFunction
) => {
    logger.error('Unhandled error:', err);

    if (res.headersSent) {
        return next(err);
    }

    if (err instanceof ZodError) {
        return sendApiError(res, 400, 'VALIDATION_ERROR', 'Request validation failed', err.issues.map((e: ZodIssue) => ({
            path: e.path.join('.'),
            message: e.message,
            code: e.code,
        })));
    }

    if (err instanceof ApiError) {
        return sendApiError(res, err.statusCode, err.code, err.message, err.details);
    }

    // Handle Prisma Errors
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        // Unique constraint violation
        if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
            const target = ((err as Prisma.PrismaClientKnownRequestError).meta?.target as string[])?.join(', ') || 'field';
            return sendApiError(res, 409, 'CONFLICT', `Record with this ${target} already exists.`);
        }

        // Record not found
        if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2025') {
            return sendApiError(res, 404, 'NOT_FOUND', 'The requested record was not found.');
        }
    }

    // Default Error
    const statusCode = (err instanceof Error && (err as any).status) || (err instanceof Error && (err as any).statusCode) || 500;
    const message = statusCode === 500 ? 'A technical error occurred. Please try again later.' : (err instanceof Error ? err.message : 'Request failed');
    const code = statusCode === 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_ERROR';
    return sendApiError(res, statusCode, code, message);
};
