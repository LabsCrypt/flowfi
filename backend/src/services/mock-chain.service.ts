/**
 * Mock chain service (issue #1336)
 *
 * Applies stream state transitions straight to the database when mock mode is
 * enabled, standing in for the Soroban contract. Every transition mirrors the
 * semantics its real counterpart enforces (see controllers/stream.controller.ts,
 * controllers/stream/cancel.ts, routes/v1/streams/withdraw.ts and the contract
 * state machine in contracts/stream_contract/README.md):
 *
 * - ownership checks (sender may pause/resume/top up/cancel, recipient withdraws)
 * - state checks (paused streams cannot be topped up, cancelled streams are permanent)
 * - an event row per transition, so activity feeds and charts have history
 * - an SSE broadcast, so connected browsers update without a page refresh
 *
 * The returned "transaction hash" is a deterministic 64-char hex string: no
 * transaction was ever broadcast, but the shape matches a Stellar hash so
 * client code that displays or links to it keeps working.
 */

import * as crypto from 'crypto';
import { ApiError } from '../lib/api-error.js';
import { prisma } from '../lib/prisma.js';
import logger from '../logger.js';
import { claimableAmountService } from './claimable.service.js';
import { sseService } from './sse.service.js';
import { StrKey } from '@stellar/stellar-sdk';

export type MockAction =
  | 'create_stream'
  | 'top_up_stream'
  | 'cancel_stream'
  | 'withdraw'
  | 'batch_withdraw'
  | 'pause_stream'
  | 'resume_stream';

export const MOCK_ACTIONS: readonly MockAction[] = [
  'create_stream',
  'top_up_stream',
  'cancel_stream',
  'withdraw',
  'batch_withdraw',
  'pause_stream',
  'resume_stream',
];

export interface MockActionParams {
  streamId?: string | undefined;
  streamIds?: string[] | undefined;
  recipient?: string | undefined;
  tokenAddress?: string | undefined;
  amount?: string | undefined;
  duration?: number | undefined;
}

export interface MockActionResult {
  success: true;
  mock: true;
  txHash: string;
  streamId: string;
  /** Populated for withdraw / batch_withdraw. */
  amount?: string;
  /** Populated for create_stream — the id assigned to the new stream. */
  streamIds?: string[];
}

type StreamRow = {
  streamId: bigint;
  sender: string;
  recipient: string;
  tokenAddress: string;
  ratePerSecond: string;
  depositedAmount: string;
  withdrawnAmount: string;
  startTime: bigint;
  lastUpdateTime: bigint;
  isActive: boolean;
  isPaused: boolean;
  pausedAt: bigint | null;
  totalPausedDuration: number;
};

function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

/**
 * Deterministic stand-in for a Stellar transaction hash (64 hex chars).
 * Exported so the Soroban layer can short-circuit simulations in mock mode
 * without duplicating the shape.
 */
export function mockTransactionHash(action: MockAction, streamId: bigint, nonce = 0): string {
  return crypto
    .createHash('sha256')
    .update(`flowfi-mock:${action}:${streamId}:${nonce}:${Date.now()}`)
    .digest('hex');
}

/** Wallets must be Ed25519 accounts. */
function requirePublicKey(value: string | undefined, field: string): string {
  if (!value || !StrKey.isValidEd25519PublicKey(value)) {
    throw new ApiError(400, `${field} is not a valid Stellar address`, 'invalid_params');
  }
  return value;
}

/**
 * A token address is a SEP-41 contract (C...), but the sandbox also accepts an
 * account-shaped address so a contributor can paste whatever their wallet shows
 * without the sandbox fighting them.
 */
function requireTokenAddress(value: string | undefined): string {
  if (
    !value ||
    (!StrKey.isValidContract(value) && !StrKey.isValidEd25519PublicKey(value))
  ) {
    throw new ApiError(
      400,
      'params.tokenAddress is not a valid Stellar address',
      'invalid_params',
    );
  }
  return value;
}

function parsePositiveAmount(value: string | undefined, field: string): bigint {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new ApiError(400, `${field} must be a positive integer string`, 'invalid_params');
  }
  const parsed = BigInt(value);
  if (parsed <= 0n) {
    throw new ApiError(400, `${field} must be greater than zero`, 'invalid_params');
  }
  return parsed;
}

async function loadStream(streamId: bigint): Promise<StreamRow> {
  const stream = (await prisma.stream.findUnique({ where: { streamId } })) as StreamRow | null;
  if (!stream) {
    throw new ApiError(404, `Stream ${streamId} not found`, 'stream_not_found');
  }
  return stream;
}

function assertSender(stream: StreamRow, caller: string): void {
  if (stream.sender !== caller) {
    throw new ApiError(403, 'Only the stream sender may perform this action', 'forbidden');
  }
}

function assertRecipient(stream: StreamRow, caller: string): void {
  if (stream.recipient !== caller) {
    throw new ApiError(403, 'Only the stream recipient may perform this action', 'forbidden');
  }
}

/**
 * Cancelled streams are permanently inactive (contract invariant): a cancelled
 * stream must never be resumable, even if a caller replays a stale pause.
 */
function assertNotCancelled(stream: StreamRow): void {
  if (!stream.isActive) {
    throw new ApiError(409, 'Stream is already cancelled or completed', 'conflict');
  }
}

async function recordEvent(
  streamId: bigint,
  eventType: string,
  txHash: string,
  timestamp: bigint,
  amount: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  await prisma.streamEvent.upsert({
    where: { transactionHash_eventType: { transactionHash: txHash, eventType } },
    update: {},
    create: {
      streamId,
      eventType,
      amount,
      transactionHash: txHash,
      ledgerSequence: 0,
      timestamp,
      metadata: JSON.stringify(metadata),
    },
  });
}

// ─── create_stream ───────────────────────────────────────────────────────────

async function createStream(
  caller: string,
  params: MockActionParams,
): Promise<MockActionResult> {
  const recipient = requirePublicKey(params.recipient, 'params.recipient');
  const tokenAddress = requireTokenAddress(params.tokenAddress);
  const amount = parsePositiveAmount(params.amount, 'params.amount');
  const duration = params.duration;

  if (
    duration === undefined ||
    !Number.isInteger(duration) ||
    duration <= 0
  ) {
    throw new ApiError(
      400,
      'params.duration must be a positive integer (seconds)',
      'invalid_params',
    );
  }

  // Mirrors the contract: the rate is derived, and a rate that rounds to zero
  // is rejected (StreamError #11) rather than silently creating a dead stream.
  const ratePerSecond = amount / BigInt(duration);
  if (ratePerSecond <= 0n) {
    throw new ApiError(
      400,
      'Rate rounds to zero — increase the amount or shorten the duration',
      'invalid_params',
    );
  }

  const highest = await prisma.stream.aggregate({ _max: { streamId: true } });
  const streamId = (highest._max.streamId ?? 0n) + 1n;
  const startTime = nowSeconds();

  const stream = await prisma.stream.create({
    data: {
      streamId,
      sender: caller,
      recipient,
      tokenAddress,
      ratePerSecond: ratePerSecond.toString(),
      depositedAmount: amount.toString(),
      withdrawnAmount: '0',
      startTime,
      lastUpdateTime: startTime,
      endTime: startTime + BigInt(duration),
      isActive: true,
    },
  });

  const txHash = mockTransactionHash('create_stream', streamId, 0);
  await recordEvent(streamId, 'CREATED', txHash, startTime, amount.toString(), {
    sender: caller,
    recipient,
    tokenAddress,
    ratePerSecond: ratePerSecond.toString(),
    durationSeconds: duration,
  });

  sseService.broadcastToStream(streamId.toString(), 'stream.created', {
    streamId: streamId.toString(),
    sender: stream.sender,
    recipient: stream.recipient,
    tokenAddress: stream.tokenAddress,
    ratePerSecond: stream.ratePerSecond,
    depositedAmount: stream.depositedAmount,
    startTime: stream.startTime,
    transactionHash: txHash,
    mock: true,
  });

  return {
    success: true,
    mock: true,
    txHash,
    streamId: streamId.toString(),
    streamIds: [streamId.toString()],
  };
}

/**
 * Persist a stream the caller already created "on chain".
 *
 * Mirrors the REST `POST /v1/streams` flow: the client submits the stream id it
 * used for the (simulated) contract call, and the API confirms the projection
 * against chain state. Offline there is no chain to confirm against, so the
 * request values are taken as-is — which is exactly what a sandbox needs to
 * exercise the projection path.
 */
export async function createStreamFromRequest(params: {
  streamId: bigint;
  sender: string;
  recipient: string;
  tokenAddress: string;
  ratePerSecond: bigint;
  depositedAmount: bigint;
  startTime: bigint;
}): Promise<MockActionResult> {
  const existing = await prisma.stream.findUnique({
    where: { streamId: params.streamId },
  });
  if (existing) {
    throw new ApiError(409, 'Stream already exists', 'conflict');
  }

  if (params.ratePerSecond <= 0n) {
    throw new ApiError(400, 'ratePerSecond must be greater than zero', 'invalid_rate');
  }

  // Same derivation the create handler applies on the real path.
  const endTime = params.startTime + params.depositedAmount / params.ratePerSecond;
  const stream = await prisma.stream.create({
    data: {
      streamId: params.streamId,
      sender: params.sender,
      recipient: params.recipient,
      tokenAddress: params.tokenAddress,
      ratePerSecond: params.ratePerSecond.toString(),
      depositedAmount: params.depositedAmount.toString(),
      withdrawnAmount: '0',
      startTime: params.startTime,
      lastUpdateTime: params.startTime,
      endTime,
      isActive: true,
    },
  });

  const txHash = mockTransactionHash('create_stream', params.streamId);
  await recordEvent(
    params.streamId,
    'CREATED',
    txHash,
    params.startTime,
    params.depositedAmount.toString(),
    {
    sender: params.sender,
    recipient: params.recipient,
    tokenAddress: params.tokenAddress,
    ratePerSecond: params.ratePerSecond.toString(),
    mock: true,
    },
  );

  sseService.broadcastToStream(params.streamId.toString(), 'stream.created', {
    streamId: stream.streamId,
    sender: stream.sender,
    recipient: stream.recipient,
    tokenAddress: stream.tokenAddress,
    ratePerSecond: stream.ratePerSecond,
    depositedAmount: stream.depositedAmount,
    startTime: stream.startTime,
    transactionHash: txHash,
    mock: true,
  });

  return {
    success: true,
    mock: true,
    txHash,
    streamId: params.streamId.toString(),
    streamIds: [params.streamId.toString()],
  };
}

// ─── pause_stream / resume_stream ────────────────────────────────────────────

export async function pauseStream(
  streamId: bigint,
  caller: string,
): Promise<MockActionResult> {
  const stream = await loadStream(streamId);
  assertSender(stream, caller);
  assertNotCancelled(stream);
  if (stream.isPaused) {
    throw new ApiError(409, 'Stream is already paused', 'conflict');
  }

  const timestamp = nowSeconds();
  const txHash = mockTransactionHash('pause_stream', streamId, 0);

  await prisma.stream.update({
    where: { streamId },
    data: { isPaused: true, pausedAt: timestamp },
  });
  await recordEvent(streamId, 'PAUSED', txHash, timestamp, null, { pausedBy: caller });

  sseService.broadcastToStream(streamId.toString(), 'stream.paused', {
    streamId: streamId.toString(),
    pausedAt: timestamp,
    transactionHash: txHash,
    mock: true,
  });

  return { success: true, mock: true, txHash, streamId: streamId.toString() };
}

export async function resumeStream(
  streamId: bigint,
  caller: string,
): Promise<MockActionResult> {
  const stream = await loadStream(streamId);
  assertSender(stream, caller);
  assertNotCancelled(stream);
  if (!stream.isPaused) {
    throw new ApiError(409, 'Stream is not paused', 'conflict');
  }

  const timestamp = nowSeconds();
  const pausedAt = stream.pausedAt ?? timestamp;
  const pausedDuration =
    timestamp > pausedAt ? Number(timestamp - pausedAt) : 0;
  const txHash = mockTransactionHash('resume_stream', streamId, 0);

  await prisma.stream.update({
    where: { streamId },
    data: {
      isPaused: false,
      pausedAt: null,
      // Accumulated pause time keeps the claimable calculation anchored to the
      // last pre-pause update, exactly as the contract does on resume.
      lastUpdateTime: timestamp,
      totalPausedDuration: { increment: pausedDuration },
    },
  });
  await recordEvent(streamId, 'RESUMED', txHash, timestamp, null, {
    resumedBy: caller,
    pausedDurationSeconds: pausedDuration,
  });

  sseService.broadcastToStream(streamId.toString(), 'stream.resumed', {
    streamId: streamId.toString(),
    resumedAt: timestamp,
    transactionHash: txHash,
    mock: true,
  });

  return { success: true, mock: true, txHash, streamId: streamId.toString() };
}

// ─── withdraw / batch_withdraw ───────────────────────────────────────────────

export async function withdraw(
  streamId: bigint,
  caller: string,
): Promise<MockActionResult> {
  const stream = await loadStream(streamId);
  assertRecipient(stream, caller);

  const claimable = claimableAmountService.getClaimableAmount(stream);
  if (!claimable.actionable) {
    throw new ApiError(409, 'No claimable balance is currently available', 'conflict');
  }

  const amount = BigInt(claimable.claimableAmount);
  const timestamp = nowSeconds();
  const txHash = mockTransactionHash('withdraw', streamId, 0);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE "Stream" SET "withdrawnAmount" = ("withdrawnAmount"::bigint + $1::bigint)::text, "lastUpdateTime" = $2 WHERE "streamId" = $3`,
      amount.toString(),
      timestamp,
      streamId,
    );
    const refreshed = await tx.stream.findUnique({ where: { streamId } });
    const drained =
      refreshed !== null &&
      BigInt(refreshed.withdrawnAmount) >= BigInt(refreshed.depositedAmount);
    if (drained && refreshed?.isActive) {
      await tx.stream.update({ where: { streamId }, data: { isActive: false } });
    }
    return { refreshed, drained };
  });

  await recordEvent(streamId, 'WITHDRAWN', txHash, timestamp, amount.toString(), {
    withdrawnBy: caller,
  });

  if (updated.drained) {
    const completedTxHash = mockTransactionHash('withdraw', streamId, 1);
    await recordEvent(streamId, 'COMPLETED', completedTxHash, timestamp, null, {
      totalStreamed: updated.refreshed?.withdrawnAmount ?? amount.toString(),
      mock: true,
    });
    sseService.broadcastToStream(streamId.toString(), 'stream.completed', {
      streamId: streamId.toString(),
      totalStreamed: updated.refreshed?.withdrawnAmount ?? amount.toString(),
      transactionHash: completedTxHash,
      mock: true,
    });
  }

  sseService.broadcastToStream(streamId.toString(), 'stream.withdrawn', {
    streamId: streamId.toString(),
    amount: amount.toString(),
    recipient: caller,
    transactionHash: txHash,
    mock: true,
  });

  return {
    success: true,
    mock: true,
    txHash,
    streamId: streamId.toString(),
    amount: amount.toString(),
  };
}

// ─── top_up_stream ───────────────────────────────────────────────────────────

export async function topUp(
  streamId: bigint,
  amount: bigint,
  caller: string,
): Promise<MockActionResult> {
  const stream = await loadStream(streamId);
  assertSender(stream, caller);
  assertNotCancelled(stream);
  if (stream.isPaused) {
    throw new ApiError(409, 'Stream is paused — resume it before topping up', 'conflict');
  }

  const timestamp = nowSeconds();
  const txHash = mockTransactionHash('top_up_stream', streamId, 0);

  await prisma.$executeRawUnsafe(
    `UPDATE "Stream" SET "depositedAmount" = ("depositedAmount"::bigint + $1::bigint)::text, "lastUpdateTime" = $2 WHERE "streamId" = $3`,
    amount.toString(),
    timestamp,
    streamId,
  );
  await recordEvent(streamId, 'TOPPED_UP', txHash, timestamp, amount.toString(), {
    toppedUpBy: caller,
  });

  const updated = await prisma.stream.findUnique({ where: { streamId } });
  sseService.broadcastToStream(streamId.toString(), 'stream.topped_up', {
    streamId: streamId.toString(),
    amount: amount.toString(),
    newBalance: updated?.depositedAmount ?? '0',
    transactionHash: txHash,
    mock: true,
  });

  return {
    success: true,
    mock: true,
    txHash,
    streamId: streamId.toString(),
    amount: amount.toString(),
  };
}

// ─── cancel_stream ───────────────────────────────────────────────────────────

export async function cancel(
  streamId: bigint,
  caller: string,
): Promise<MockActionResult> {
  const stream = await loadStream(streamId);
  assertSender(stream, caller);
  assertNotCancelled(stream);

  const timestamp = nowSeconds();
  const txHash = mockTransactionHash('cancel_stream', streamId, 0);

  await prisma.stream.update({
    where: { streamId },
    data: { isActive: false, isPaused: false, pausedAt: null },
  });
  await recordEvent(streamId, 'CANCELLED', txHash, timestamp, null, {
    cancelledBy: caller,
    refundAmount: stream.depositedAmount,
  });

  sseService.broadcastToStream(streamId.toString(), 'stream.cancelled', {
    streamId: streamId.toString(),
    refundedAmount: stream.depositedAmount,
    transactionHash: txHash,
    mock: true,
  });

  return { success: true, mock: true, txHash, streamId: streamId.toString() };
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

export async function applyMockAction(
  action: MockAction,
  caller: string,
  params: MockActionParams,
): Promise<MockActionResult> {
  switch (action) {
    case 'create_stream':
      return createStream(caller, params);

    case 'pause_stream':
    case 'resume_stream':
    case 'cancel_stream':
    case 'withdraw': {
      if (params.streamId === undefined || !/^\d+$/.test(params.streamId)) {
        throw new ApiError(400, 'params.streamId must be a numeric string', 'invalid_params');
      }
      const streamId = BigInt(params.streamId);
      switch (action) {
        case 'pause_stream':
          return pauseStream(streamId, caller);
        case 'resume_stream':
          return resumeStream(streamId, caller);
        case 'cancel_stream':
          return cancel(streamId, caller);
        default:
          return withdraw(streamId, caller);
      }
    }

    case 'top_up_stream': {
      if (params.streamId === undefined || !/^\d+$/.test(params.streamId)) {
        throw new ApiError(400, 'params.streamId must be a numeric string', 'invalid_params');
      }
      return topUp(
        BigInt(params.streamId),
        parsePositiveAmount(params.amount, 'params.amount'),
        caller,
      );
    }

    case 'batch_withdraw': {
      const ids = params.streamIds ?? [];
      if (ids.length === 0) {
        throw new ApiError(
          400,
          'params.streamIds must contain at least one stream id',
          'invalid_params',
        );
      }
      // The contract reverts the whole batch if any single stream fails, so a
      // partially applied sandbox batch would be misleading — validate first,
      // then apply.
      for (const id of ids) {
        if (!/^\d+$/.test(id)) {
          throw new ApiError(400, `Invalid stream id: ${id}`, 'invalid_params');
        }
      }
      const results: MockActionResult[] = [];
      let totalWithdrawn = 0n;
      for (const id of ids) {
        const result = await withdraw(BigInt(id), caller);
        results.push(result);
        totalWithdrawn += BigInt(result.amount ?? '0');
      }
      const [first] = results;
      if (!first) {
        throw new ApiError(400, 'params.streamIds must contain at least one stream id', 'invalid_params');
      }
      return {
        success: true,
        mock: true,
        txHash: first.txHash,
        streamId: first.streamId,
        streamIds: results.map((result) => result.streamId),
        amount: totalWithdrawn.toString(),
      };
    }

    default: {
      const exhaustive: never = action;
      throw new ApiError(400, `Unsupported mock action: ${String(exhaustive)}`, 'invalid_action');
    }
  }
}

/** Mock log line kept alongside the normal request logs for easy grepping. */
export function logMockAction(action: MockAction, caller: string, result: MockActionResult): void {
  logger.info(
    `[MockMode] action=${action} caller=${caller} stream=${result.streamId} txHash=${result.txHash}`,
  );
}