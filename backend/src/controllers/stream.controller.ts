import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import logger from '../logger.js';

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
    const { streamId } = req.params;

    const stream = await prisma.stream.findUnique({
      where: { streamId: parseInt(streamId) },
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
    const { streamId } = req.params;

    const events = await prisma.streamEvent.findMany({
      where: { streamId: parseInt(streamId) },
      orderBy: { timestamp: 'desc' }
    });

    return res.status(200).json(events);
  } catch (error) {
    logger.error('Error fetching stream events:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
