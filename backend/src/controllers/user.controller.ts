import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import logger from '../logger.js';
import { registerUserSchema } from '../validators/user.validator.js';
import type { AuthenticatedRequest } from '../types/auth.types.js';

/**
 * Register a new wallet public key
 */
export const registerUser = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const validated = registerUserSchema.parse(req.body);
        const { publicKey } = validated;

        // Check if user already exists
        let user = await prisma.user.findUnique({
            where: { publicKey }
        });

        if (user) {
            return res.status(200).json(user);
        }

        // Create new user
        user = await prisma.user.create({
            data: { publicKey }
        });

        logger.info(`User registered: ${publicKey}`);
        return res.status(201).json(user);
    } catch (error) {
        next(error);
    }
};

/**
 * Get user by public key
 */
export const getUser = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const publicKey = req.params.publicKey as string;

        const user = await prisma.user.findUnique({
            where: { publicKey },
            include: {
                sentStreams: {
                    take: 10,
                    orderBy: { createdAt: 'desc' }
                },
                receivedStreams: {
                    take: 10,
                    orderBy: { createdAt: 'desc' }
                }
            }
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        return res.status(200).json(user);
    } catch (error) {
        next(error);
    }
};

/**
 * Get user events (history)
 */
export const getUserEvents = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { publicKey } = req.params;

        const events = await prisma.streamEvent.findMany({
            where: {
                stream: {
                    OR: [
                        { sender: publicKey },
                        { recipient: publicKey }
                    ]
                }
            },
            orderBy: { timestamp: 'desc' },
            include: {
                stream: true
            }
        });

        return res.status(200).json(events);
    } catch (error) {
        next(error);
    }
};

/**
 * Get current authenticated user
 * Requires authMiddleware to be applied
 */
export const getCurrentUser = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const authReq = req as AuthenticatedRequest;
        const { publicKey } = authReq.user;

        // Try to get user from database
        let user = await prisma.user.findUnique({
            where: { publicKey },
            include: {
                sentStreams: {
                    take: 10,
                    orderBy: { createdAt: 'desc' }
                },
                receivedStreams: {
                    take: 10,
                    orderBy: { createdAt: 'desc' }
                }
            }
        });

        // If user doesn't exist in database, create in-memory user object
        if (!user) {
            logger.info(`User ${publicKey} authenticated but not in database, returning in-memory user`);
            return res.status(200).json({
                publicKey,
                sentStreams: [],
                receivedStreams: [],
                inMemory: true
            });
        }

        return res.status(200).json(user);
    } catch (error) {
        next(error);
    }
};
