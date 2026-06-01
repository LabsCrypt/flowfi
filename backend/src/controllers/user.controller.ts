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
        if (typeof publicKey !== 'string') {
            return res.status(400).json({ error: 'Invalid publicKey parameter' });
        }
        if (!/^G[A-Z2-7]{55}$/.test(publicKey)) {
            return res.status(400).json({ error: 'Invalid Stellar public key format' });
        }

        const rawLimit = req.query['limit'];
        const rawOffset = req.query['offset'];

        const limit = Math.min(
            rawLimit && typeof rawLimit === 'string' ? (Number.parseInt(rawLimit, 10) || 50) : 50,
            200
        );
        const offset = rawOffset && typeof rawOffset === 'string' ? (Number.parseInt(rawOffset, 10) || 0) : 0;

        const whereClause = {
            stream: {
                OR: [
                    { sender: publicKey },
                    { recipient: publicKey }
                ]
            }
        };

        const [events, total] = await Promise.all([
            prisma.streamEvent.findMany({
                where: whereClause,
                orderBy: { timestamp: 'desc' },
                take: limit,
                skip: offset,
                include: {
                    stream: true
                }
            }),
            prisma.streamEvent.count({ where: whereClause })
        ]);

        const hasMore = offset + events.length < total;

        return res.status(200).json({
            data: events,
            total,
            hasMore,
            limit,
            offset
        });
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
