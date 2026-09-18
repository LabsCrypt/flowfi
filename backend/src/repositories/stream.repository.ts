import { prisma } from '../lib/prisma.js';

/**
 * Update the status and active flag of a stream in the database.
 */
export const updateStatus = async (streamId: bigint, status: 'ACTIVE' | 'CANCELLED' | 'COMPLETED' | 'PAUSED') => {
  return prisma.stream.update({
    where: { streamId },
    data: {
      isActive: status === 'ACTIVE' || status === 'PAUSED',
      // Note: we don't have a 'status' field in the Stream model yet,
      // it seems status is derived from isActive and events.
      // However, we can update isActive to false for CANCELLED/COMPLETED.
    }
  });
};

/**
 * Cancel a stream and create a provisional CANCELLED StreamEvent in the same transaction.
 * This ensures the stream immediately appears under the "cancelled" filter.
 * The indexer will later reconcile/deduplicate this event when it processes the on-chain event.
 */
export const cancelStreamWithEvent = async (
  streamId: bigint,
  txHash: string,
): Promise<void> => {
  const timestamp = Math.floor(Date.now() / 1000);

  await prisma.$transaction(async (tx) => {
    await tx.stream.update({
      where: { streamId },
      data: { isActive: false },
    });

    await tx.streamEvent.upsert({
      where: {
        transactionHash_eventType: {
          transactionHash: txHash,
          eventType: 'CANCELLED',
        },
      },
      create: {
        streamId,
        eventType: 'CANCELLED',
        amount: null,
        transactionHash: txHash,
        ledgerSequence: 0,
        timestamp,
        metadata: JSON.stringify({ provisional: true }),
      },
      update: {
        ledgerSequence: 0,
        timestamp,
        metadata: JSON.stringify({ provisional: true }),
      },
    });
  });
};

type StreamWhere = {
  sender?: string;
  recipient?: string;
  tokenAddress?: string;
  isActive?: boolean;
  isPaused?: boolean;
  events?: { some: { eventType: string } };
};

export interface FindStreamsParams {
  status?: 'active' | 'paused' | 'cancelled' | 'completed';
  sender?: string;
  recipient?: string;
  tokenAddress?: string;
  limit: number;
  offset: number;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface FindStreamsResult {
  streams: unknown[];
  total: number;
  hasMore: boolean;
}

export const findStreams = async (params: FindStreamsParams): Promise<FindStreamsResult> => {
  const where: StreamWhere = {};

  if (params.sender) where.sender = params.sender;
  if (params.recipient) where.recipient = params.recipient;
  if (params.tokenAddress) where.tokenAddress = params.tokenAddress;

  if (params.status) {
    switch (params.status) {
      case 'active':
        where.isActive = true;
        where.isPaused = false;
        break;
      case 'paused':
        where.isPaused = true;
        break;
      case 'cancelled':
        where.isActive = false;
        where.events = { some: { eventType: 'CANCELLED' } };
        break;
      case 'completed':
        where.isActive = false;
        where.events = { some: { eventType: 'COMPLETED' } };
        break;
    }
  }

  const sortField = params.sortField || 'startTime';
  const sortOrder = params.sortOrder || 'desc';

  const [streams, total] = await Promise.all([
    prisma.stream.findMany({
      where,
      orderBy: { [sortField]: sortOrder },
      take: params.limit,
      skip: params.offset,
      include: {
        senderUser: true,
        recipientUser: true,
      },
    }),
    prisma.stream.count({ where }),
  ]);

  return { streams, total, hasMore: params.offset + streams.length < total };
};
