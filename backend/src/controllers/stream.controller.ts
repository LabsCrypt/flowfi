import type { Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "../generated/prisma/index.js";
import { prisma } from "../lib/prisma.js";
import logger from "../logger.js";
import { claimableAmountService } from "../services/claimable.service.js";
import {
  getStreamFromChain,
  getClaimableFromChain,
  isStale,
  topUpStream,
  pauseStream as sorobanPauseStream,
  resumeStream as sorobanResumeStream,
} from "../services/sorobanService.js";
import type { AuthenticatedRequest } from "../types/auth.types.js";
import { parseStreamId } from "../lib/stream-id.js";
import { createStreamSchema } from "../validators/stream.validator.js";
import {
  DEFAULT_EVENTS_PAGE_SIZE,
  MAX_EVENTS_PAGE_SIZE,
} from "../repositories/streamEvent.repository.js";
import { findStreams } from "../repositories/stream.repository.js";
import { sendApiError } from "../types/api-error.js";

const DEFAULT_STREAM_PAGE_SIZE = 20;
const MAX_STREAM_PAGE_SIZE = 100;

/**
 * Hard cap on the number of streams fetched per user in the summary endpoint.
 * Prevents unbounded DB queries when a wallet has thousands of streams.
 * Users who exceed this cap receive a truncated summary (counts and totals
 * reflect only the most recent streams) plus a `truncated` flag so the
 * frontend can offer a pagination or export fallback.
 */
export const MAX_USER_STREAMS = 500;

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

// Issue #682: Periodic prune to prevent memory drift when no requests come in
setInterval(() => {
  pruneUserSummaryCache(Date.now());
}, 60_000); // Run every 60 seconds

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
  try {
    const callerPublicKey = (req as AuthenticatedRequest).user?.publicKey;
    if (!callerPublicKey) {
      return sendApiError(res, 401, 'UNAUTHORIZED', 'Authentication required');
    }

    const parsed = createStreamSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
        .join('; ');
      return sendApiError(res, 400, 'INVALID_REQUEST', message);
    }

    const {
      streamId: parsedStreamId,
      sender,
      recipient,
      tokenAddress,
      ratePerSecond,
      depositedAmount,
      startTime: parsedStartTime,
    } = parsed.data;

    // Issue #809: the authenticated wallet may only create/modify streams it owns.
    // Without this, any logged-in wallet could POST an arbitrary `sender` and have
    // it persisted, or flip another owner's cancelled stream back to active.
    if (sender !== callerPublicKey) {
      return sendApiError(res, 403, 'FORBIDDEN', 'sender must match the authenticated wallet');
    }

    const parsedRatePerSecond = BigInt(ratePerSecond);
    const parsedDepositedAmount = BigInt(depositedAmount);

    if (parsedRatePerSecond <= 0n) {
      return sendApiError(res, 400, 'INVALID_RATE', 'Invalid ratePerSecond: must be greater than zero');
    }

    if (parsedDepositedAmount <= 0n) {
      return sendApiError(res, 400, 'INVALID_DEPOSITED_AMOUNT', 'Invalid depositedAmount: must be greater than zero');
    }

    const endTime =
      BigInt(parsedStartTime) + (parsedDepositedAmount / parsedRatePerSecond);

    // Issue #809: never let the upsert update branch touch a stream owned by a
    // different wallet. The caller is already proven to equal `sender` above, so
    // reject any existing row whose sender differs — this blocks reactivating or
    // overwriting someone else's (e.g. cancelled) stream.
    const existing = await prisma.stream.findUnique({ where: { streamId: parsedStreamId } });
    if (existing && existing.sender !== callerPublicKey) {
      return sendApiError(res, 403, 'FORBIDDEN', 'Cannot modify a stream owned by another wallet');
    }

    const stream = await prisma.stream.upsert({
      where: { streamId: parsedStreamId },
      update: {
        isActive: true,
        lastUpdateTime: BigInt(Math.floor(Date.now() / 1000)),
      },
      create: {
        streamId: parsedStreamId,
        sender,
        recipient,
        tokenAddress,
        ratePerSecond,
        depositedAmount,
        withdrawnAmount: "0",
        startTime: BigInt(parsedStartTime),
        endTime,
        lastUpdateTime: BigInt(parsedStartTime),
      },
    });

    return res.status(201).json(JSON.parse(JSON.stringify(stream, (_key, value) => typeof value === "bigint" ? value.toString() : value)));
  } catch (error) {
    if (
      error instanceof RangeError ||
      error instanceof SyntaxError ||
      error instanceof TypeError
    ) {
      logger.error("Numeric parsing error in createStream:", error);
      return sendApiError(res, 400, 'INVALID_NUMERIC_VALUES', 'Invalid numeric values in request body');
    }
    logger.error("Error creating/upserting stream:", error);
    return sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'A technical error occurred. Please try again later.');
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
      sort = "createdAt",
      order = "desc",
      limit = "20",
      offset = "0",
    } = req.query;

    // Validate status parameter
    if (typeof status === "string") {
      const validStatuses = ["active", "cancelled", "completed", "paused"];
      if (!validStatuses.includes(status)) {
        return sendApiError(res, 400, "INVALID_STATUS", `status must be one of: ${validStatuses.join(", ")}`);
      }
    }

    // Validate sort field
    const validSortFields = [
      "createdAt",
      "startTime",
      "lastUpdateTime",
      "depositedAmount",
      "endTime",
    ];
    const sortField = validSortFields.includes(
      typeof sort === "string" ? sort : "createdAt",
    )
      ? (sort as
          | "createdAt"
          | "startTime"
          | "lastUpdateTime"
          | "depositedAmount"
          | "endTime")
      : "createdAt";

    // Validate and parse pagination parameters
    const parsedLimit = Math.min(
      typeof limit === "string"
        ? Number.parseInt(limit, 10) || DEFAULT_STREAM_PAGE_SIZE
        : DEFAULT_STREAM_PAGE_SIZE,
      MAX_STREAM_PAGE_SIZE,
    );
    const parsedOffset = typeof offset === 'string' ? Math.max(0, Number.parseInt(offset, 10) || 0) : 0;

    const params: import("../repositories/stream.repository.js").FindStreamsParams = {
      limit: parsedLimit,
      offset: parsedOffset,
      sortField,
      sortOrder: order === "asc" ? "asc" : "desc",
    };
    if (typeof sender === "string") params.sender = sender;
    if (typeof recipient === "string") params.recipient = recipient;
    if (typeof token === "string") params.tokenAddress = token;
    if (typeof status === "string") {
      params.status = status as 'active' | 'cancelled' | 'completed' | 'paused';
    }

    const result = await findStreams(params);

    return res.status(200).json({
      data: result.streams,
      total: result.total,
      hasMore: result.hasMore,
      limit: parsedLimit,
      offset: parsedOffset,
    });
  } catch (error) {
    logger.error("Error listing streams:", error);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "A technical error occurred. Please try again later.");
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
    const parsedStreamId = parseStreamId(streamIdParam);
    if (parsedStreamId === null) {
      return sendApiError(res, 400, "INVALID_STREAM_ID", "Invalid streamId parameter");
    }

    const stream = await prisma.stream.findUnique({
      where: { streamId: parsedStreamId },
      include: {
        senderUser: true,
        recipientUser: true,
        events: {
          orderBy: { timestamp: "desc" },
        },
      },
    });

    if (!stream) {
      // Fallback: try live RPC
      const chainStream = await getStreamFromChain(parsedStreamId);
      if (!chainStream) {
        return sendApiError(res, 404, "NOT_FOUND", "Stream not found");
      }
      return res.status(200).json({ ...chainStream, source: "chain" });
    }

    // If DB data is stale, attempt live RPC fallback
    if (isStale(stream.updatedAt)) {
      const chainStream = await getStreamFromChain(parsedStreamId);
      if (chainStream) {
        return res
          .status(200)
          .json({ ...stream, ...chainStream, source: "chain" });
      }
    }

    return res.status(200).json(stream);
  } catch (error) {
    logger.error("Error fetching stream:", error);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "A technical error occurred. Please try again later.");
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
    const parsedStreamId = parseStreamId(streamIdParam);
    if (parsedStreamId === null) {
      return sendApiError(res, 400, "INVALID_STREAM_ID", "Invalid streamId parameter");
    }

    const rawLimit = req.query["limit"];
    const rawOffset = req.query["offset"];
    const rawPage = req.query["page"];
    const cursor =
      typeof req.query["cursor"] === "string" ? req.query["cursor"] : undefined;
    const order =
      req.query["order"] === "asc" ? ("asc" as const) : ("desc" as const);
    const eventType =
      typeof req.query["eventType"] === "string"
        ? req.query["eventType"]
        : undefined;

    const limit = Math.min(
      rawLimit && typeof rawLimit === "string"
        ? Number.parseInt(rawLimit, 10) || DEFAULT_EVENTS_PAGE_SIZE
        : DEFAULT_EVENTS_PAGE_SIZE,
      MAX_EVENTS_PAGE_SIZE,
    );

    let offset = 0;
    if (rawOffset && typeof rawOffset === 'string') {
      offset = Math.max(0, Number.parseInt(rawOffset, 10) || 0);
    } else if (rawPage && typeof rawPage === 'string' && !cursor) {
      const page = Number.parseInt(rawPage, 10) || 1;
      offset = Math.max(0, (page - 1) * limit);
    }

    const whereClause: Prisma.StreamEventWhereInput = {
      streamId: parsedStreamId,
    };
    if (eventType) {
      const validEventTypes = [
        "CREATED",
        "TOPPED_UP",
        "WITHDRAWN",
        "CANCELLED",
        "COMPLETED",
        "PAUSED",
        "RESUMED",
        "FEE_COLLECTED",
        "FEE_CONFIG_UPDATED",
        "ADMIN_TRANSFERRED",
      ];
      if (!validEventTypes.includes(eventType)) {
        return sendApiError(res, 400, "INVALID_EVENT_TYPE", `eventType must be one of: ${validEventTypes.join(", ")}`);
      }
      whereClause.eventType = eventType;
    }

    const [events, total] = await Promise.all([
      prisma.streamEvent.findMany({
        where: whereClause,
        // `timestamp` is not unique (events in the same block/ledger can
        // share a timestamp), so it can't be the sole sort key for cursor
        // pagination. Add `id` as a unique tiebreaker so ordering (and
        // therefore cursor pagination) is stable across pages.
        orderBy: [{ timestamp: order }, { id: order }],
        take: limit,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : { skip: offset }),
      }),
      prisma.streamEvent.count({ where: whereClause }),
    ]);

    const hasMore = cursor
      ? events.length === limit
      : offset + events.length < total;

    return res.status(200).json({ data: events, total, hasMore });
  } catch (error) {
    logger.error("Error fetching stream events:", error);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "A technical error occurred. Please try again later.");
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
    const parsedStreamId = parseStreamId(streamIdParam);
    if (parsedStreamId === null) {
      return sendApiError(res, 400, "INVALID_STREAM_ID", "Invalid streamId parameter");
    }

    const atQuery = req.query.at as string | undefined;
    let requestedAt: number | undefined;

    if (atQuery !== undefined) {
      requestedAt = Number.parseInt(atQuery, 10);
      if (!Number.isFinite(requestedAt) || requestedAt < 0) {
        return sendApiError(res, 400, "INVALID_QUERY_PARAMETER", "'at' must be a non-negative Unix timestamp in seconds");
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
          source: "chain",
        });
      }
      return sendApiError(res, 404, "NOT_FOUND", "Stream not found");
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
          source: "chain",
        });
      }
    }

    const result = claimableAmountService.getClaimableAmount(
      stream,
      requestedAt,
    );

    return res.status(200).json(result);
  } catch (error) {
    logger.error("Error calculating stream claimable amount:", error);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "A technical error occurred. Please try again later.");
  }
};

/**
 * Get user-level stream summary used by dashboard/profile cards.
 */
export const getUserStreamSummary = async (
  req: Request<{ address: string }>,
  res: Response,
) => {
  try {
    const address = Array.isArray(req.params.address)
      ? req.params.address[0]
      : (req.params.address ?? "").trim();
    if (!address) {
      return sendApiError(res, 400, "INVALID_ADDRESS", "Address is required");
    }

    const nowMs = Date.now();
    const cacheKey = address;
    const cached = userSummaryCache.get(cacheKey);
    if (cached && cached.expiresAtMs > nowMs) {
      return res.status(200).json(cached.value);
    }

    pruneUserSummaryCache(nowMs);

    // Issue #1246: cap the number of streams fetched per direction to prevent
    // unbounded DB queries.  Power users with more than MAX_USER_STREAMS
    // streams receive a truncated summary (the `truncated` flag lets the
    // frontend offer a pagination/export fallback).
    const [outgoingStreams, incomingStreams] = await Promise.all([
      prisma.stream.findMany({
        where: { sender: address },
        orderBy: { startTime: "desc" },
        take: MAX_USER_STREAMS,
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
      prisma.stream.findMany({
        where: { recipient: address },
        orderBy: { startTime: "desc" },
        take: MAX_USER_STREAMS,
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

    const calculatedAt = Math.floor(nowMs / 1000);

    let claimableInTotal = 0n;
    for (const stream of incomingStreams) {
      const claimable = claimableAmountService.getClaimableAmount(
        stream,
        calculatedAt,
      );
      claimableInTotal += BigInt(claimable.claimableAmount);
    }

    const totalStreamsCreated = outgoingStreams.length;
    const totalStreamedOut = sumStringI128(
      outgoingStreams.map((stream: any) => stream.withdrawnAmount),
    );
    const totalStreamedIn = sumStringI128(
      incomingStreams.map((stream: any) => stream.withdrawnAmount),
    );

    const activeOutgoingCount = outgoingStreams.filter(
      (stream: any) => stream.isActive,
    ).length;
    const activeIncomingCount = incomingStreams.filter(
      (stream: any) => stream.isActive,
    ).length;

    const truncated =
      outgoingStreams.length >= MAX_USER_STREAMS ||
      incomingStreams.length >= MAX_USER_STREAMS;

    const summary = {
      address,
      totalStreamsCreated,
      totalStreamedOut,
      totalStreamedIn,
      currentClaimable: claimableInTotal.toString(),
      activeOutgoingCount,
      activeIncomingCount,
      ...(truncated ? { truncated: true } : {}),
    } satisfies UserStreamSummary & { truncated?: boolean };

    userSummaryCache.set(cacheKey, {
      value: summary,
      expiresAtMs: nowMs + USER_SUMMARY_CACHE_TTL_MS,
    });

    return res.status(200).json(summary);
  } catch (error) {
    logger.error("Error fetching user stream summary:", error);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "A technical error occurred. Please try again later.");
  }
};

const TOP_UP_AMOUNT_MAX_DIGITS = 30;

const topUpBodySchema = z.object({
  amount: z
    .string()
    .regex(/^\d+$/, "amount must be a positive integer string (XLM stroops)")
    .max(
      TOP_UP_AMOUNT_MAX_DIGITS,
      `amount must be at most ${TOP_UP_AMOUNT_MAX_DIGITS} digits long`,
    ),
});

/**
 * POST /v1/streams/:streamId/top-up
 * Adds tokens to a running stream. Only the stream sender may call this.
 */
export const topUpStreamHandler = async (req: Request, res: Response) => {
  const streamId = parseStreamId(
    Array.isArray(req.params.streamId)
      ? req.params.streamId[0]
      : req.params.streamId,
  );
  if (streamId === null) {
    return sendApiError(res, 400, "INVALID_STREAM_ID", "Invalid streamId");
  }

  const parsed = topUpBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return sendApiError(res, 400, "VALIDATION_ERROR", "Request validation failed", parsed.error.issues);
  }

  const amount = BigInt(parsed.data.amount);
  if (amount <= 0n) {
    return sendApiError(res, 400, "INVALID_AMOUNT", "amount must be a positive integer");
  }

  const callerAddress = (req as AuthenticatedRequest).user?.publicKey;
  if (!callerAddress) {
    return sendApiError(res, 401, "UNAUTHORIZED", "Authentication required");
  }

  try {
    const stream = await prisma.stream.findUnique({ where: { streamId } });
    if (!stream) {
      return sendApiError(res, 404, "NOT_FOUND", "Stream not found");
    }
    if (stream.sender !== callerAddress) {
      return sendApiError(res, 403, "FORBIDDEN", "Only the stream sender may top up this stream");
    }

    if (!stream.isActive) {
      return sendApiError(res, 409, "CONFLICT", "Cannot top up an inactive stream");
    }
    if (stream.isPaused) {
      return sendApiError(res, 409, "CONFLICT", "Cannot top up a paused stream");
    }

    const txHash = await topUpStream(streamId, amount, callerAddress);

    // Use raw SQL atomic increment to prevent concurrent top-ups from
    // overwriting each other's updates (Issue #1217 — read-compute-write race).
    // Prisma's built-in { increment } is unavailable on String-typed columns,
    // so we perform SET deposited_amount = deposited_amount + $1::bigint
    // directly in a single SQL statement.
    const now = BigInt(Math.floor(Date.now() / 1000));
    await prisma.$executeRawUnsafe(
      `UPDATE "Stream" SET "depositedAmount" = ("depositedAmount"::bigint + $1::bigint)::text, "lastUpdateTime" = $2 WHERE "streamId" = $3`,
      amount.toString(),
      now,
      streamId,
    );
    const updatedStream = await prisma.stream.findUnique({ where: { streamId } });

    logger.info(`[topUp] stream=${streamId} amount=${amount} txHash=${txHash}`);
    return res
      .status(200)
      .json({ streamId, txHash, depositedAmount: updatedStream!.depositedAmount });
  } catch (error: any) {
    logger.error(`[topUp] stream=${streamId} error:`, error);
    return sendApiError(res, 400, "TOP_UP_FAILED", "Failed to top up stream on chain");
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
      return sendApiError(res, 401, "UNAUTHORIZED", "Authentication required");
    }

    const streamIdParam = Array.isArray(req.params.streamId)
      ? req.params.streamId[0]
      : req.params.streamId;
    const parsedStreamId = parseStreamId(streamIdParam);
    if (parsedStreamId === null) {
      return sendApiError(res, 400, "INVALID_STREAM_ID", "Invalid streamId parameter");
    }

    // Fetch the stream from database
    const stream = await prisma.stream.findUnique({
      where: { streamId: parsedStreamId },
    });

    if (!stream) {
      return sendApiError(res, 404, "NOT_FOUND", "Stream not found");
    }

    // Verify the caller is the stream sender
    if (stream.sender !== authReq.user.publicKey) {
      return sendApiError(res, 403, "FORBIDDEN", "Only the stream sender can pause the stream");
    }

    // Check if stream is already paused
    if (stream.isPaused) {
      return sendApiError(res, 409, "CONFLICT", "Stream is already paused");
    }

    // Check if stream is still active
    if (!stream.isActive) {
      return sendApiError(res, 409, "CONFLICT", "Cannot pause an inactive stream");
    }

    try {
      // Call Soroban service to verify the pause operation would succeed
      const result = await sorobanPauseStream(
        authReq.user.publicKey,
        parsedStreamId,
      );

      logger.info(
        `Stream ${parsedStreamId} pause simulated by ${authReq.user.publicKey}`,
      );

      return res.status(200).json({
        success: true,
        streamId: parsedStreamId,
        txHash: result.txHash,
        stream,
      });
    } catch (sorobanError) {
      logger.error(
        `Soroban pause failed for stream ${parsedStreamId}:`,
        sorobanError,
      );
      return sendApiError(res, 400, "PAUSE_FAILED", "Failed to pause stream on chain");
    }
  } catch (error) {
    logger.error("Error pausing stream:", error);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "A technical error occurred. Please try again later.");
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
      return sendApiError(res, 401, "UNAUTHORIZED", "Authentication required");
    }

    const streamIdParam = Array.isArray(req.params.streamId)
      ? req.params.streamId[0]
      : req.params.streamId;
    const parsedStreamId = parseStreamId(streamIdParam);
    if (parsedStreamId === null) {
      return sendApiError(res, 400, "INVALID_STREAM_ID", "Invalid streamId parameter");
    }

    // Fetch the stream from database
    const stream = await prisma.stream.findUnique({
      where: { streamId: parsedStreamId },
    });

    if (!stream) {
      return sendApiError(res, 404, "NOT_FOUND", "Stream not found");
    }

    // Verify the caller is the stream sender
    if (stream.sender !== authReq.user.publicKey) {
      return sendApiError(res, 403, "FORBIDDEN", "Only the stream sender can resume the stream");
    }

    // Check if stream is paused
    if (!stream.isPaused) {
      return sendApiError(res, 409, "CONFLICT", "Stream is not paused");
    }

    try {
      // Call Soroban service to verify the resume operation would succeed
      const result = await sorobanResumeStream(
        authReq.user.publicKey,
        parsedStreamId,
      );

      logger.info(
        `Stream ${parsedStreamId} resume simulated by ${authReq.user.publicKey}`,
      );

      return res.status(200).json({
        success: true,
        streamId: parsedStreamId,
        txHash: result.txHash,
        stream,
      });
    } catch (sorobanError) {
      logger.error(
        `Soroban resume failed for stream ${parsedStreamId}:`,
        sorobanError,
      );
      return sendApiError(res, 400, "RESUME_FAILED", "Failed to resume stream on chain");
    }
  } catch (error) {
    logger.error("Error resuming stream:", error);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "A technical error occurred. Please try again later.");
  }
};
