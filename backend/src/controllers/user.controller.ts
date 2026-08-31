import type { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma.js";
import logger from "../logger.js";
import {
  registerUserSchema,
  STELLAR_PUBLIC_KEY_REGEX,
} from "../validators/user.validator.js";
import type { AuthenticatedRequest } from "../types/auth.types.js";
import {
  DEFAULT_EVENTS_PAGE_SIZE,
  MAX_EVENTS_PAGE_SIZE,
} from "../routes/v1/events.routes.js";
import * as exportService from "../services/export.service.js";

/**
 * Public shape of a Stream, used when embedding streams inside a public
 * user response. Excludes nothing sensitive today, but is kept explicit
 * so newly added internal-only fields on the Stream model are not
 * leaked automatically.
 */
const publicStreamSelect = {
  id: true,
  streamId: true,
  sender: true,
  recipient: true,
  tokenAddress: true,
  ratePerSecond: true,
  depositedAmount: true,
  withdrawnAmount: true,
  startTime: true,
  lastUpdateTime: true,
  endTime: true,
  isActive: true,
  isPaused: true,
  pausedAt: true,
  totalPausedDuration: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Public shape of a User. Limits the response to fields that are safe to
 * expose to any caller, so internal-only fields added to the User model
 * later are excluded by default rather than leaked automatically.
 */
const publicUserSelect = {
  id: true,
  publicKey: true,
  createdAt: true,
  updatedAt: true,
  sentStreams: {
    take: 10,
    orderBy: { createdAt: "desc" as const },
    select: publicStreamSelect,
  },
  receivedStreams: {
    take: 10,
    orderBy: { createdAt: "desc" as const },
    select: publicStreamSelect,
  },
};

/**
 * Register a new wallet public key
 */
export const registerUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const validated = registerUserSchema.parse(req.body);
    const { publicKey } = validated;

    // Check if user already exists
    let user = await prisma.user.findUnique({
      where: { publicKey },
    });

    if (user) {
      return res.status(200).json(user);
    }

    // Create new user
    user = await prisma.user.create({
      data: { publicKey },
    });

    logger.info(`User registered: ${publicKey}`);
    return res.status(201).json(user);
  } catch (error) {
    return next(error);
  }
};

/**
 * Get user by public key
 */
export const getUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { publicKey } = req.params;
    if (typeof publicKey !== "string") {
      return res.status(400).json({ error: "Invalid publicKey parameter" });
    }
    if (!STELLAR_PUBLIC_KEY_REGEX.test(publicKey)) {
      return res
        .status(400)
        .json({ error: "Invalid Stellar public key format" });
    }

    const user = await prisma.user.findUnique({
      where: { publicKey },
      select: publicUserSelect,
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.status(200).json(user);
  } catch (error) {
    return next(error);
  }
};

/**
 * Get user events (history)
 */
export const getUserEvents = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const { publicKey } = req.params;
    if (typeof publicKey !== "string") {
      return res.status(400).json({ error: "Invalid publicKey parameter" });
    }
    if (!STELLAR_PUBLIC_KEY_REGEX.test(publicKey)) {
      return res
        .status(400)
        .json({ error: "Invalid Stellar public key format" });
    }

    const rawLimit = req.query["limit"];
    const rawOffset = req.query["offset"];

    const limit = Math.min(
      rawLimit && typeof rawLimit === "string"
        ? Number.parseInt(rawLimit, 10) || DEFAULT_EVENTS_PAGE_SIZE
        : DEFAULT_EVENTS_PAGE_SIZE,
      MAX_EVENTS_PAGE_SIZE,
    );
    const offset =
      rawOffset && typeof rawOffset === "string"
        ? Math.max(0, Number.parseInt(rawOffset, 10) || 0)
        : 0;

    const whereClause = {
      stream: {
        OR: [{ sender: publicKey }, { recipient: publicKey }],
      },
    };

    const [events, total] = await Promise.all([
      prisma.streamEvent.findMany({
        where: whereClause,
        orderBy: { timestamp: "desc" },
        take: limit,
        skip: offset,
        include: {
          stream: true,
        },
      }),
      prisma.streamEvent.count({ where: whereClause }),
    ]);

    const hasMore = offset + events.length < total;

    return res.status(200).json({
      data: events,
      total,
      hasMore,
      limit,
      offset,
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * Get current authenticated user
 * Requires authMiddleware to be applied
 */
export const getCurrentUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const { publicKey } = authReq.user;

    // Try to get user from database
    let user = await prisma.user.findUnique({
      where: { publicKey },
      include: {
        sentStreams: {
          take: 10,
          orderBy: { createdAt: "desc" },
        },
        receivedStreams: {
          take: 10,
          orderBy: { createdAt: "desc" },
        },
      },
    });

    // If user doesn't exist in database, create in-memory user object
    if (!user) {
      logger.info(
        `User ${publicKey} authenticated but not in database, returning in-memory user`,
      );
      return res.status(200).json({
        publicKey,
        sentStreams: [],
        receivedStreams: [],
        inMemory: true,
      });
    }

    return res.status(200).json(user);
  } catch (error) {
    return next(error);
  }
};

/**
 * Export user transactions for accounting and tax purposes (Issue #1191)
 */
export const exportTransactions = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const addressParam = req.params.address;
    const address = Array.isArray(addressParam)
      ? addressParam[0]
      : addressParam;

    if (!address || !STELLAR_PUBLIC_KEY_REGEX.test(address)) {
      return res.status(400).json({ error: "Invalid Stellar address" });
    }

    const format = (req.query.format as string) || "csv";
    const direction =
      (req.query.direction as "incoming" | "outgoing" | "all") || "all";
    const startDate = req.query.startDate
      ? new Date(req.query.startDate as string)
      : null;
    const endDate = req.query.endDate
      ? new Date(req.query.endDate as string)
      : null;
    const tokenAddress = (req.query.tokenAddress as string | null) || null;

    if (!["csv", "json"].includes(format)) {
      return res
        .status(400)
        .json({ error: "Invalid format. Must be csv or json" });
    }

    if (!["incoming", "outgoing", "all"].includes(direction)) {
      return res.status(400).json({
        error: "Invalid direction. Must be incoming, outgoing, or all",
      });
    }

    const options: exportService.ExportOptions = {
      format: format as "csv" | "json",
      direction,
      startDate,
      endDate,
      tokenAddress,
    };

    if (format === "csv") {
      await exportService.streamTransactionCSV(address, options, res);
    } else {
      await exportService.streamTransactionJSON(address, options, res);
    }
  } catch (error) {
    logger.error("[Export] Error:", error);
    if (!res.headersSent) {
      return next(error);
    }
  }
};
