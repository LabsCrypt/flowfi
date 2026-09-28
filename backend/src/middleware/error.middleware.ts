import type { Request, Response, NextFunction } from 'express';
import { ZodError, type ZodIssue } from 'zod';
import logger from '../logger.js';
import { ApiError as TypeApiError, sendApiError } from '../types/api-error.js';
import { ApiError as LibApiError, fromPrismaError, sanitizeDatabaseErrorMessage } from '../lib/api-error.js';

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

    // Intercept Prisma database errors to prevent schema disclosure
    const prismaError = fromPrismaError(err);
    if (prismaError) {
        return sendApiError(res, prismaError.status, prismaError.code, prismaError.message);
    }

    if (
        err instanceof TypeApiError ||
        err instanceof LibApiError ||
        (err instanceof Error && 'statusCode' in err && 'code' in err) ||
        (err instanceof Error && 'status' in err && 'code' in err)
    ) {
        const statusCode = (err as any).statusCode ?? (err as any).status ?? 500;
        const code = (err as any).code || (statusCode === 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_ERROR');
        let message = (err as any).message || 'Request failed';
        message = sanitizeDatabaseErrorMessage(message, statusCode);
        return sendApiError(res, statusCode, code, message, (err as any).details);
    }

    // Default Error
    const statusCode = (err instanceof Error && (err as any).status) || (err instanceof Error && (err as any).statusCode) || 500;
    let message = statusCode === 500 ? 'A technical error occurred. Please try again later.' : (err instanceof Error ? err.message : 'Request failed');
    message = sanitizeDatabaseErrorMessage(message, statusCode);
    const code = statusCode === 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_ERROR';
    return sendApiError(res, statusCode, code, message);
};

