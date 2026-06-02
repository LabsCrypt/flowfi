import type { Request, Response, NextFunction } from 'express';
import { Prisma } from '../generated/prisma/index.js';
import { ZodError, type ZodIssue } from 'zod';
import logger from '../logger.js';

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

    // Handle Zod Validation Errors
    if (err instanceof ZodError) {
        return res.status(400).json({
            error: 'Validation Error',
            details: err.issues.map((e: ZodIssue) => ({
                path: e.path.join('.'),
                message: e.message
            }))
        });
    }

    // Handle Prisma Errors
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        // Unique constraint violation
        if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
            const target = ((err as Prisma.PrismaClientKnownRequestError).meta?.target as string[])?.join(', ') || 'field';
            return res.status(409).json({
                error: 'Conflict Error',
                message: `Record with this ${target} already exists.`
            });
        }

        // Record not found
        if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2025') {
            return res.status(404).json({
                error: 'Not Found',
                message: (err as Prisma.PrismaClientKnownRequestError).message || 'The requested record was not found.'
            });
        }
    }

    // Default Error
    const statusCode = (err instanceof Error && (err as any).status) || (err instanceof Error && (err as any).statusCode) || 500;
    const message = err instanceof Error ? err.message : 'Internal Server Error';

    return res.status(statusCode).json({
        error: statusCode === 500 ? 'Internal Server Error' : 'Error',
        message: statusCode === 500 ? 'A technical error occurred. Please try again later.' : message
    });
};
