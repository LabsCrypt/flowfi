import type { Request, Response, NextFunction } from 'express';
import { ZodError, type ZodIssue } from 'zod';
import logger from '../logger.js';
import {
  ApiError,
  fromPrismaError,
  sanitizeDatabaseErrorMessage,
  sendApiError,
} from '../lib/api-error.js';

/**
 * Shape of the third-party errors that reach this handler. `express`,
 * `body-parser` and the auth libraries attach a status (and sometimes a machine
 * code) to a plain `Error`, so the handler reads those fields through this
 * interface instead of through `any`.
 */
interface StatusedError extends Error {
  status?: number;
  statusCode?: number;
  code?: string;
  type?: string;
  details?: unknown;
}

const asStatusedError = (err: unknown): StatusedError | null =>
  err instanceof Error ? err : null;

/** The status an error asks to be answered with, or 500 when it says nothing. */
const statusOf = (err: StatusedError): number =>
  err.statusCode ?? err.status ?? 500;

/**
 * The status this error will be answered with, before anything is sent.
 *
 * Needed because the log line and the response must agree on severity: logging
 * every rejected request at `error` level buries the failures worth waking up
 * for (#1901).
 */
function resolveErrorStatus(err: unknown): number {
    if (err instanceof ZodError) return 400;

    const prismaError = fromPrismaError(err);
    if (prismaError) return prismaError.statusCode;

    if (err instanceof ApiError) return err.statusCode;

    const candidate = err as { status?: unknown; statusCode?: unknown };
    if (typeof candidate?.status === 'number') return candidate.status;
    if (typeof candidate?.statusCode === 'number') return candidate.statusCode;

    return 500;
}

/**
 * Global error handler middleware
 */
export const errorHandler = (
    err: unknown,
    req: Request,
    res: Response,
    next: NextFunction
) => {
    const resolvedStatus = resolveErrorStatus(err);

    if (resolvedStatus >= 500) {
        // Only server-side failures are incidents. A rejected request is the
        // API working: it is logged at warn, with the route, so it stays visible
        // without drowning the error stream.
        logger.error('Unhandled error:', err);
    } else {
        logger.warn(
            `Request rejected with ${resolvedStatus}: ${req.method} ${req.originalUrl}`,
        );
    }

    if (res.headersSent) {
        return next(err);
    }

    const statused = asStatusedError(err);

    // body-parser signals an over-limit body with `type: 'entity.too.large'`
    // (and status 413). Translate it to the API's standard JSON error envelope
    // instead of leaking the raw parser message.
    if (statused?.type === 'entity.too.large' || (statused !== null && statusOf(statused) === 413)) {
        return sendApiError(
            res,
            413,
            'PAYLOAD_TOO_LARGE',
            'Request payload exceeds the allowed size limit.',
        );
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
        return sendApiError(res, prismaError.statusCode, prismaError.code, prismaError.message);
    }

    // The application's own error type: the thrower already chose the status,
    // the code and any details, so only the message needs sanitising.
    if (err instanceof ApiError) {
        return sendApiError(
            res,
            err.statusCode,
            err.code,
            sanitizeDatabaseErrorMessage(err.message, err.statusCode),
            err.details,
        );
    }

    if (statused) {
        const statusCode = statusOf(statused);
        const rawMessage = statusCode === 500
            ? 'A technical error occurred. Please try again later.'
            : (statused.message || 'Request failed');
        return sendApiError(
            res,
            statusCode,
            statused.code || (statusCode === 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_ERROR'),
            sanitizeDatabaseErrorMessage(rawMessage, statusCode),
            statused.details,
        );
    }

    // A thrown non-Error (a string, an object literal): report a generic 500
    // rather than echoing an unknown payload back to the caller.
    return sendApiError(
        res,
        500,
        'INTERNAL_SERVER_ERROR',
        'A technical error occurred. Please try again later.',
    );
};
