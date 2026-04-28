import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import logger from '../logger.js';
import { claimableAmountService } from '../services/claimable.service.js';
import { getStreamFromChain, getClaimableFromChain, isStale } from '../services/sorobanService.js';

/**
 * Create a new stream (stub for on-chain indexing)
 */
export const createStream = async (req: Request, res: Response) => {
  // This would typically involve validating the stream already exists on-chain
  // or preparing metadata for the frontend to submit the transaction.
  // For now, let's allow "registering" a stream if it doesn't exist.
  try {
    const { streamId, sender, recipient, tokenAddress, ratePerSecond, depositedAmount, startTime } = req.body;

    const stream = await prisma.stream.upsert({
      where: { streamId: parseInt(streamId) },
      update: {
        isActive: true,
        lastUpdateTime: Math.floor(Date.now() / 1000)
      },
      create: {
        streamId: parseInt(streamId),
        sender,
        recipient,
        tokenAddress,
        ratePerSecond,
        depositedAmount,
        withdrawnAmount: "0",
        startTime: parseInt(startTime),
        lastUpdateTime: parseInt(startTime)
      }
    });

    return res.status(201).json(stream);
  } catch (error) {
    logger.error('Error creating/upserting stream:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * List streams by sender or recipient
 */
export const listStreams = async (req: Request, res: Response) => {
  try {
    const { sender, recipient } = req.query;

    const where: any = {};
    if (typeof sender === 'string') where.sender = sender;
    if (typeof recipient === 'string') where.recipient = recipient;

    const streams = await prisma.stream.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        senderUser: true,
        recipientUser: true
      }
    });

    return res.status(200).json(streams);
  } catch (error) {
    logger.error('Error listing streams:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Get a single stream by ID
 */
export const getStream = async (req: Request, res: Response) => {
  try {
    const streamIdParam = Array.isArray(req.params.streamId)
      ? req.params.streamId[0]
      : req.params.streamId;
    const parsedStreamId = Number.parseInt(streamIdParam ?? '', 10);

    if (!Number.isFinite(parsedStreamId)) {
      return res.status(400).json({ error: 'Invalid streamId parameter' });
    }

    const stream = await prisma.stream.findUnique({
      where: { streamId: parsedStreamId },
      include: {
        senderUser: true,
        recipientUser: true,
        events: {
          orderBy: { timestamp: 'desc' }
        }
      }
    });

    if (!stream) {
      // Fallback: try live RPC
      const chainStream = await getStreamFromChain(parsedStreamId);
      if (!chainStream) {
        return res.status(404).json({ error: 'Stream not found' });
      }
      return res.status(200).json({ ...chainStream, source: 'chain' });
    }

    // If DB data is stale, attempt live RPC fallback
    if (isStale(stream.updatedAt)) {
      const chainStream = await getStreamFromChain(parsedStreamId);
      if (chainStream) {
        return res.status(200).json({ ...stream, ...chainStream, source: 'chain' });
      }
    }

    return res.status(200).json(stream);
  } catch (error) {
    logger.error('Error fetching stream:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * List events for a stream (paginated)
 */
export const getStreamEvents = async (req: Request, res: Response) => {
  try {
    const streamIdParam = Array.isArray(req.params.streamId)
      ? req.params.streamId[0]
      : req.params.streamId;
    const parsedStreamId = Number.parseInt(streamIdParam ?? '', 10);

    if (!Number.isFinite(parsedStreamId)) {
      return res.status(400).json({ error: 'Invalid streamId parameter' });
    }

    const rawLimit = req.query['limit'];
    const rawOffset = req.query['offset'];
    const cursor = typeof req.query['cursor'] === 'string' ? req.query['cursor'] : undefined;
    const direction = req.query['direction'] === 'asc' ? 'asc' as const : 'desc' as const;
    const order = req.query['order'] === 'asc' ? 'asc' as const : 'desc' as const;
    const eventType = typeof req.query['eventType'] === 'string' ? req.query['eventType'] : undefined;

    const limit = Math.min(
      rawLimit && typeof rawLimit === 'string' ? (Number.parseInt(rawLimit, 10) || 50) : 50,
      500,
    );
    const offset =
      rawOffset && typeof rawOffset === 'string' ? (Number.parseInt(rawOffset, 10) || 0) : 0;

    const whereClause: any = { streamId: parsedStreamId };
    if (eventType) {
      const validEventTypes = ['CREATED', 'TOPPED_UP', 'WITHDRAWN', 'CANCELLED', 'COMPLETED', 'PAUSED', 'RESUMED'];
      if (!validEventTypes.includes(eventType)) {
        return res.status(400).json({ 
          error: 'Invalid eventType parameter',
          message: `eventType must be one of: ${validEventTypes.join(', ')}`
        });
      }
      whereClause.type = eventType;
    }

    const [events, total] = await Promise.all([
      prisma.streamEvent.findMany({
        where: whereClause,
        orderBy: { createdAt: order },
        take: limit,
        ...(cursor
          ? { cursor: { id: cursor }, skip: 1 }
          : { skip: offset }),
      }),
      prisma.streamEvent.count({ where: whereClause }),
    ]);

    const hasMore = cursor
      ? events.length === limit
      : offset + events.length < total;

    return res.status(200).json({ data: events, total, hasMore });
  } catch (error) {
    logger.error('Error fetching stream events:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Get actionable claimable amount for a stream (no direct RPC call).
 */
export const getStreamClaimableAmount = async (req: Request, res: Response) => {
  try {
    const streamIdParam = Array.isArray(req.params.streamId)
      ? req.params.streamId[0]
      : req.params.streamId;
    const parsedStreamId = Number.parseInt(streamIdParam ?? '', 10);

    if (!Number.isFinite(parsedStreamId)) {
      return res.status(400).json({ error: 'Invalid streamId parameter' });
    }

    const atQuery = req.query.at as string | undefined;
    let requestedAt: number | undefined;

    if (atQuery !== undefined) {
      requestedAt = Number.parseInt(atQuery, 10);
      if (!Number.isFinite(requestedAt) || requestedAt < 0) {
        return res.status(400).json({
          error: 'Invalid query parameter',
          message: "'at' must be a non-negative Unix timestamp in seconds",
        });
      }
    }

    const stream = await prisma.stream.findUnique({
      where: { streamId: parsedStreamId },
      select: {
        streamId: true,
        ratePerSecond: true,
        depositedAmount: true,
        withdrawnAmount: true,
        lastUpdateTime: true,
        isActive: true,
        updatedAt: true,
      },
    });

    if (!stream) {
      // Fallback: try live RPC for claimable amount
      const chainClaimable = await getClaimableFromChain(parsedStreamId);
      if (chainClaimable !== null) {
        return res.status(200).json({
          streamId: parsedStreamId,
          claimableAmount: chainClaimable,
          actionable: BigInt(chainClaimable) > 0n,
          calculatedAt: Math.floor(Date.now() / 1000),
          cached: false,
          source: 'chain',
        });
      }
      return res.status(404).json({ error: 'Stream not found' });
    }

    // If DB data is stale, use live RPC
    if (isStale(stream.updatedAt)) {
      const chainClaimable = await getClaimableFromChain(parsedStreamId);
      if (chainClaimable !== null) {
        return res.status(200).json({
          streamId: parsedStreamId,
          claimableAmount: chainClaimable,
          actionable: BigInt(chainClaimable) > 0n,
          calculatedAt: Math.floor(Date.now() / 1000),
          cached: false,
          source: 'chain',
        });
      }
    }

    const result = claimableAmountService.getClaimableAmount(stream, requestedAt);

    return res.status(200).json(result);
  } catch (error) {
    logger.error('Error calculating stream claimable amount:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
