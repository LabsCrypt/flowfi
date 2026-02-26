import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import logger from '../logger.js';
import { claimableAmountService } from '../services/claimable.service.js';

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
    if (sender) where.sender = sender as string;
    if (recipient) where.recipient = recipient as string;

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
      return res.status(404).json({ error: 'Stream not found' });
    }

    return res.status(200).json(stream);
  } catch (error) {
    logger.error('Error fetching stream:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * List events for a stream
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

    const events = await prisma.streamEvent.findMany({
      where: { streamId: parsedStreamId },
      orderBy: { timestamp: 'desc' }
    });

    return res.status(200).json(events);
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
      return res.status(404).json({ error: 'Stream not found' });
    }

    const result = claimableAmountService.getClaimableAmount(stream, requestedAt);

    return res.status(200).json(result);
  } catch (error) {
    logger.error('Error calculating stream claimable amount:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
