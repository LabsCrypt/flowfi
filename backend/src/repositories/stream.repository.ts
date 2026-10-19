import { prisma, withReplicaFallback } from '../lib/prisma.js';
import type { Prisma } from '../generated/prisma/index.js';

/**
 * Transaction client passed to interactive Prisma transactions.
 */
export type PrismaTxClient = Prisma.TransactionClient;

/**
 * Atomically mark a stream as cancelled (via the API) and write a provisional
 * CANCELLED StreamEvent in the same transaction.
 *
 * The indexer's handleStreamCancelled writes an authoritative event for the
 * real on-chain StreamCancelled event later; both variants share the
 * (transactionHash, eventType) unique key, so the indexer reconciles (updates)
 * the provisional record instead of creating a duplicate.
 *
 * Issue #1219: without the provisional event the cancelled stream matched
 * neither the "active" filter (isActive=false) nor the "cancelled" filter
 * (requires a CANCELLED event) and disappeared from all status views until
 * the on-chain event was indexed.
 */
export const markCancelledProvisionally = async (
  streamId: bigint,
  txHash: string,
  txClient?: PrismaTxClient,
) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const run = async (tx: PrismaTxClient) => {
    await tx.stream.update({
      where: { streamId },
      data: {
        isActive: false,
      },
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
        // Ledger details are unknown until the indexer sees the real event;
        // ledgerSequence 0 + provisional metadata marks this as API-written.
        ledgerSequence: 0,
        timestamp,
        metadata: JSON.stringify({ provisional: true, source: 'api-cancel' }),
      },
      // If another request already wrote the provisional event for this
      // transaction, don't clobber it with a second provisional copy.
      update: {},
    });
  };

  if (txClient) {
    return run(txClient);
  }
  return prisma.$transaction(run);
};

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

  const [streams, total] = await withReplicaFallback((client) => Promise.all([
    client.stream.findMany({
      where,
      orderBy: { [sortField]: sortOrder },
      take: params.limit,
      skip: params.offset,
      include: {
        senderUser: true,
        recipientUser: true,
      },
    }),
    client.stream.count({ where }),
  ]));

  return { streams, total, hasMore: params.offset + streams.length < total };
};
