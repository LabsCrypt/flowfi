import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import logger from '../logger.js';
import { claimableAmountService } from '../services/claimable.service.js';
import { getStreamFromChain, getClaimableFromChain, isStale, pauseStream as sorobanPauseStream, resumeStream as sorobanResumeStream } from '../services/sorobanService.js';
import type { AuthenticatedRequest } from '../types/auth.types.js';

interface UserStreamSummary {
  address: string;
  totalStreamsCreated: number;
  totalStreamedOut: string;
  totalStreamedIn: string;
  currentClaimable: string;
  activeOutgoingCount: number;
  activeIncomingCount: number;
}

interface UserSummaryCacheEntry {
  value: UserStreamSummary;
  expiresAtMs: number;
}

const USER_SUMMARY_CACHE_TTL_MS = 30_000;
const userSummaryCache = new Map<string, UserSummaryCacheEntry>();

function pruneUserSummaryCache(nowMs: number): void {
  for (const [key, entry] of userSummaryCache.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      userSummaryCache.delete(key);
    }
  }
}

function sumStringI128(values: string[]): string {
  let total = 0n;
  for (const value of values) {
    try {
      total += BigInt(value);
    } catch {
      logger.warn(`[UserSummary] Skipping invalid i128 value: ${value}`);
    }
  }
  return total.toString();
}

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
        endTime: parseInt(startTime) + Number(BigInt(depositedAmount) / BigInt(ratePerSecond)),
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
 * List streams by sender, recipient, status, token with sorting and pagination
 */
export const listStreams = async (req: Request, res: Response) => {
  try {
    const { 
      sender, 
      recipient, 
      status, 
      token,
      sort = 'createdAt',
      order = 'desc',
      limit = '20',
      offset = '0'
    } = req.query;

    const where: any = {};
    if (typeof sender === 'string') where.sender = sender;
    if (typeof recipient === 'string') where.recipient = recipient;
    if (typeof token === 'string') where.tokenAddress = token;

    // Handle status filtering
    if (typeof status === 'string') {
      const validStatuses = ['active', 'cancelled', 'completed', 'paused'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ 
          error: 'Invalid status parameter',
          message: `status must be one of: ${validStatuses.join(', ')}`
        });
      }

      // Map status to database conditions
      switch (status) {
        case 'active':
          where.isActive = true;
          where.isPaused = false;
          break;
        case 'cancelled':
          where.isActive = false;
          where.events = { some: { eventType: 'CANCELLED' } };
          break;
        case 'completed':
          where.isActive = false;
          where.events = { some: { eventType: 'COMPLETED' } };
          break;
        case 'paused':
          where.isPaused = true;
          break;
      }
    }

    // Validate and parse pagination parameters
    const parsedLimit = Math.min(
      typeof limit === 'string' ? (Number.parseInt(limit, 10) || 20) : 20,
      100
    );
    const parsedOffset = typeof offset === 'string' ? (Number.parseInt(offset, 10) || 0) : 0;

    // Validate sort field
    const validSortFields = ['createdAt', 'startTime', 'lastUpdateTime', 'depositedAmount', 'endTime'];
    const sortField = validSortFields.includes(typeof sort === 'string' ? sort : 'createdAt') 
      ? (sort as 'createdAt' | 'startTime' | 'lastUpdateTime' | 'depositedAmount' | 'endTime') 
      : 'createdAt';

    // Validate order
    const sortOrder = order === 'asc' ? 'asc' : 'desc';

    const [streams, total] = await Promise.all([
      prisma.stream.findMany({
        where,
        orderBy: { [sortField]: sortOrder },
        take: parsedLimit,
        skip: parsedOffset,
        include: {
          senderUser: true,
          recipientUser: true
        }
      }),
      prisma.stream.count({ where })
    ]);

    const hasMore = parsedOffset + streams.length < total;

    return res.status(200).json({ 
      data: streams, 
      total, 
      hasMore,
      limit: parsedLimit,
      offset: parsedOffset
    });
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
      const validEventTypes = ['CREATED', 'TOPPED_UP', 'WITHDRAWN', 'CANCELLED', 'COMPLETED', 'PAUSED', 'RESUMED', 'FEE_COLLECTED'];
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
        startTime: true,
        lastUpdateTime: true,
        isActive: true,
        isPaused: true,
        pausedAt: true,
        totalPausedDuration: true,
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

/**
 * Get user-level stream summary used by dashboard/profile cards.
 */
export const getUserStreamSummary = async (req: Request<{ address: string }>, res: Response) => {
  try {
    const address = Array.isArray(req.params.address) ? req.params.address[0] : (req.params.address ?? '').trim();
    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    const nowMs = Date.now();
    const cacheKey = address;
    const cached = userSummaryCache.get(cacheKey);
    if (cached && cached.expiresAtMs > nowMs) {
      return res.status(200).json(cached.value);
    }

    pruneUserSummaryCache(nowMs);

    const [outgoingStreams, incomingStreams] = await Promise.all([
      prisma.stream.findMany({
        where: { sender: address },
        select: {
          withdrawnAmount: true,
          isActive: true,
        },
      }),
      prisma.stream.findMany({
        where: { recipient: address },
        select: {
          streamId: true,
          ratePerSecond: true,
          depositedAmount: true,
          withdrawnAmount: true,
          startTime: true,
          lastUpdateTime: true,
          isActive: true,
          isPaused: true,
          pausedAt: true,
          totalPausedDuration: true,
          updatedAt: true,
        },
      }),
    ]);

    const totalStreamsCreated = outgoingStreams.length;
    const totalStreamedOut = sumStringI128(outgoingStreams.map((stream: any) => stream.withdrawnAmount));
    const totalStreamedIn = sumStringI128(incomingStreams.map((stream: any) => stream.withdrawnAmount));
    const activeOutgoingCount = outgoingStreams.filter((stream: any) => stream.isActive).length;
    const activeIncomingCount = incomingStreams.filter((stream: any) => stream.isActive).length;

    const calculatedAt = Math.floor(nowMs / 1000);
    let claimableTotal = 0n;
    for (const stream of incomingStreams) {
      if (!stream.isActive) continue;
      const claimable = claimableAmountService.getClaimableAmount(stream, calculatedAt);
      claimableTotal += BigInt(claimable.claimableAmount);
    }

    const summary: UserStreamSummary = {
      address,
      totalStreamsCreated,
      totalStreamedOut,
      totalStreamedIn,
      currentClaimable: claimableTotal.toString(),
      activeOutgoingCount,
      activeIncomingCount,
    };

    userSummaryCache.set(cacheKey, {
      value: summary,
      expiresAtMs: nowMs + USER_SUMMARY_CACHE_TTL_MS,
    });

    return res.status(200).json(summary);
  } catch (error) {
    logger.error('Error fetching user stream summary:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Pause a stream. Only the sender can pause their own stream.
 * Validates the request, checks ownership, and updates the database.
 */
export const pauseStream = async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    
    if (!authReq.user) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    }

    const streamIdParam = Array.isArray(req.params.streamId)
      ? req.params.streamId[0]
      : req.params.streamId;
    const parsedStreamId = Number.parseInt(streamIdParam ?? '', 10);

    if (!Number.isFinite(parsedStreamId)) {
      return res.status(400).json({ error: 'Invalid streamId parameter' });
    }

    // Fetch the stream from database
    const stream = await prisma.stream.findUnique({
      where: { streamId: parsedStreamId },
    });

    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    // Verify the caller is the stream sender
    if (stream.sender !== authReq.user.publicKey) {
      return res.status(403).json({ 
        error: 'Forbidden',
        message: 'Only the stream sender can pause the stream'
      });
    }

    // Check if stream is already paused
    if (stream.isPaused) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'Stream is already paused'
      });
    }

    // Check if stream is still active
    if (!stream.isActive) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'Cannot pause an inactive stream'
      });
    }

    try {
      // Call Soroban service to verify the pause operation would succeed
      const result = await sorobanPauseStream(authReq.user.publicKey, parsedStreamId);

      // Update the database to mark stream as paused
      const now = Math.floor(Date.now() / 1000);
      const updatedStream = await prisma.stream.update({
        where: { streamId: parsedStreamId },
        data: {
          isPaused: true,
          pausedAt: now,
          lastUpdateTime: now,
        },
      });

      // Create a PAUSED event
      await prisma.streamEvent.create({
        data: {
          streamId: parsedStreamId,
          eventType: 'PAUSED',
          txHash: result.txHash,
          ledgerSequence: 0, // Will be updated by event indexer
          timestamp: now,
          metadata: JSON.stringify({ pausedBy: authReq.user.publicKey }),
        },
      });

      logger.info(`Stream ${parsedStreamId} paused by ${authReq.user.publicKey}`);

      return res.status(200).json({
        success: true,
        streamId: parsedStreamId,
        txHash: result.txHash,
        stream: updatedStream,
      });
    } catch (sorobanError) {
      logger.error(`Soroban pause failed for stream ${parsedStreamId}:`, sorobanError);
      return res.status(400).json({
        error: 'Failed to pause stream on chain',
        message: sorobanError instanceof Error ? sorobanError.message : 'Unknown error',
      });
    }
  } catch (error) {
    logger.error('Error pausing stream:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Resume a paused stream. Only the sender can resume their own stream.
 * Validates the request, checks ownership, and updates the database.
 */
export const resumeStream = async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    
    if (!authReq.user) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
    }

    const streamIdParam = Array.isArray(req.params.streamId)
      ? req.params.streamId[0]
      : req.params.streamId;
    const parsedStreamId = Number.parseInt(streamIdParam ?? '', 10);

    if (!Number.isFinite(parsedStreamId)) {
      return res.status(400).json({ error: 'Invalid streamId parameter' });
    }

    // Fetch the stream from database
    const stream = await prisma.stream.findUnique({
      where: { streamId: parsedStreamId },
    });

    if (!stream) {
      return res.status(404).json({ error: 'Stream not found' });
    }

    // Verify the caller is the stream sender
    if (stream.sender !== authReq.user.publicKey) {
      return res.status(403).json({ 
        error: 'Forbidden',
        message: 'Only the stream sender can resume the stream'
      });
    }

    // Check if stream is paused
    if (!stream.isPaused) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'Stream is not paused'
      });
    }

    try {
      // Call Soroban service to verify the resume operation would succeed
      const result = await sorobanResumeStream(authReq.user.publicKey, parsedStreamId);

      // Calculate pause duration and update the database
      const now = Math.floor(Date.now() / 1000);
      const pausedAt = stream.pausedAt ?? now;
      const pauseDuration = Math.max(0, now - pausedAt);
      const totalPausedDuration = (stream.totalPausedDuration ?? 0) + pauseDuration;

      const updatedStream = await prisma.stream.update({
        where: { streamId: parsedStreamId },
        data: {
          isPaused: false,
          pausedAt: null,
          totalPausedDuration,
          lastUpdateTime: now,
        },
      });

      // Create a RESUMED event
      await prisma.streamEvent.create({
        data: {
          streamId: parsedStreamId,
          eventType: 'RESUMED',
          txHash: result.txHash,
          ledgerSequence: 0, // Will be updated by event indexer
          timestamp: now,
          metadata: JSON.stringify({ 
            resumedBy: authReq.user.publicKey,
            pauseDuration,
          }),
        },
      });

      logger.info(`Stream ${parsedStreamId} resumed by ${authReq.user.publicKey}`);

      return res.status(200).json({
        success: true,
        streamId: parsedStreamId,
        txHash: result.txHash,
        stream: updatedStream,
      });
    } catch (sorobanError) {
      logger.error(`Soroban resume failed for stream ${parsedStreamId}:`, sorobanError);
      return res.status(400).json({
        error: 'Failed to resume stream on chain',
        message: sorobanError instanceof Error ? sorobanError.message : 'Unknown error',
      });
    }
  } catch (error) {
    logger.error('Error resuming stream:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
