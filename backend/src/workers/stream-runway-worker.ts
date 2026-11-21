/**
 * Stream Runway & Low-Balance Alert Engine (Issue #1190)
 * Monitors active streams and generates proactive notifications before funds run out
 */
import type { Stream } from "../generated/prisma/index.js";
import { prisma } from "../lib/prisma.js";
import logger from "../logger.js";
import { claimableAmountService } from "../services/claimable.service.js";
import { sseService } from "../services/sse.service.js";

/**
 * Streams read per round trip. Large enough that the query count is negligible
 * for a normal hour, small enough that a page of records cannot dominate the
 * worker's memory: the previous unbounded `findMany` loaded every active
 * stream and then made one or two dedup queries per stream, serially (#1899).
 */
const STREAM_PAGE_SIZE = 500;

const WARNING_THRESHOLD_HOURS = 48;
const CRITICAL_THRESHOLD_HOURS = 24;
const DEDUPLICATION_WINDOW_HOURS = 24;

interface RunwayCalculation {
  streamId: bigint;
  remainingRunwaySeconds: number;
  unclaimedBalance: bigint;
  claimableNow: bigint;
  sender: string;
  recipient: string;
}

/**
 * Calculate remaining runway for a stream in seconds
 */
function calculateStreamRunway(stream: Stream, now: number): RunwayCalculation {
  const result = claimableAmountService.getClaimableAmount(
    {
      streamId: stream.streamId,
      tokenAddress: stream.tokenAddress,
      ratePerSecond: stream.ratePerSecond,
      depositedAmount: stream.depositedAmount,
      withdrawnAmount: stream.withdrawnAmount,
      startTime: stream.startTime,
      lastUpdateTime: stream.lastUpdateTime,
      isActive: stream.isActive,
      isPaused: stream.isPaused,
      pausedAt: stream.pausedAt,
      totalPausedDuration: stream.totalPausedDuration,
    },
    now,
  );

  const claimableNow = BigInt(result.claimableAmount);
  const unclaimedBalance =
    BigInt(stream.depositedAmount) - BigInt(stream.withdrawnAmount);
  const remainingBalance = unclaimedBalance - claimableNow;
  const ratePerSecond = BigInt(stream.ratePerSecond);

  let remainingRunwaySeconds = 0;
  if (ratePerSecond > 0n && remainingBalance > 0n) {
    remainingRunwaySeconds = Number(remainingBalance / ratePerSecond);
  }

  return {
    streamId: stream.streamId,
    remainingRunwaySeconds,
    unclaimedBalance,
    claimableNow,
    sender: stream.sender,
    recipient: stream.recipient,
  };
}

/**
 * Check if alert was recently sent to prevent spam
 */
/**
 * Which of `streamIds` already received `alertType` inside the deduplication
 * window.
 *
 * One query per page instead of one per stream: the alert history is keyed by
 * `(streamId, alertType)` with a `sentAt` index, so a single range scan answers
 * the whole page.
 */
async function recentlyAlertedStreams(
  streamIds: bigint[],
  alertType: string,
  cutoff: Date,
): Promise<Set<string>> {
  if (streamIds.length === 0) return new Set();

  const rows = await prisma.alertHistory.findMany({
    where: {
      streamId: { in: streamIds },
      alertType,
      sentAt: { gte: cutoff },
    },
    select: { streamId: true },
  });

  return new Set(rows.map((row) => row.streamId.toString()));
}

/**
 * Record alert in history
 */
async function recordAlert(streamId: bigint, alertType: string): Promise<void> {
  await prisma.alertHistory.create({
    data: {
      streamId,
      alertType,
    },
  });
}

/**
 * Send low balance alert via SSE and webhooks
 */
async function sendLowBalanceAlert(
  runway: RunwayCalculation,
  alertType: "WARNING_48H" | "CRITICAL_24H",
): Promise<void> {
  const hoursRemaining = runway.remainingRunwaySeconds / 3600;

  const alertData = {
    streamId: runway.streamId.toString(),
    alertType,
    remainingRunwaySeconds: runway.remainingRunwaySeconds,
    hoursRemaining: Math.floor(hoursRemaining * 10) / 10,
    unclaimedBalance: runway.unclaimedBalance.toString(),
    sender: runway.sender,
    recipient: runway.recipient,
    timestamp: new Date().toISOString(),
  };

  // Send SSE notification to sender
  sseService.broadcastToUser(runway.sender, "STREAM_LOW_BALANCE", alertData);

  // Send SSE notification to recipient (informational)
  sseService.broadcastToUser(runway.recipient, "STREAM_LOW_BALANCE", alertData);

  // Broadcast to stream subscribers
  sseService.broadcastToStream(
    runway.streamId.toString(),
    "STREAM_LOW_BALANCE",
    alertData,
  );

  logger.info(
    `[RunwayWorker] ${alertType} alert sent for stream ${runway.streamId}: ${hoursRemaining.toFixed(1)}h remaining`,
  );
}

/**
 * Main worker function - runs every hour
 */
export async function runStreamRunwayCheck(): Promise<void> {
  const startTime = Date.now();
  logger.info("[RunwayWorker] Starting runway check...");

  try {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = new Date(
      Date.now() - DEDUPLICATION_WINDOW_HOURS * 60 * 60 * 1000,
    );
    let warningsSent = 0;
    let criticalsSent = 0;
    let checked = 0;

    // Keyset pagination: the stream table is ordered by its unique id, so a
    // cursor is exact and does not drift as streams are created during the run.
    // Every page costs one stream query and, at most, two alert-history queries
    // — constant in the number of streams being checked.
    let cursor: bigint | undefined;

    for (;;) {
      const page = await prisma.stream.findMany({
        where: {
          isActive: true,
          isPaused: false,
        },
        orderBy: { streamId: "asc" },
        take: STREAM_PAGE_SIZE,
        ...(cursor === undefined
          ? {}
          : { cursor: { streamId: cursor }, skip: 1 }),
      });

      if (page.length === 0) break;
      checked += page.length;

      const critical = await recentlyAlertedStreams(
        page.map((stream) => stream.streamId),
        "CRITICAL_24H",
        cutoff,
      );
      const warning = await recentlyAlertedStreams(
        page.map((stream) => stream.streamId),
        "WARNING_48H",
        cutoff,
      );

      for (const stream of page) {
        try {
          const runway = calculateStreamRunway(stream, now);
          const key = stream.streamId.toString();

          // Check critical threshold (24 hours)
          if (runway.remainingRunwaySeconds <= CRITICAL_THRESHOLD_HOURS * 3600) {
            if (!critical.has(key)) {
              await sendLowBalanceAlert(runway, "CRITICAL_24H");
              await recordAlert(stream.streamId, "CRITICAL_24H");
              criticalsSent++;
            }
          }
          // Check warning threshold (48 hours)
          else if (
            runway.remainingRunwaySeconds <=
            WARNING_THRESHOLD_HOURS * 3600
          ) {
            if (!warning.has(key)) {
              await sendLowBalanceAlert(runway, "WARNING_48H");
              await recordAlert(stream.streamId, "WARNING_48H");
              warningsSent++;
            }
          }
        } catch (error) {
          logger.error(
            `[RunwayWorker] Error processing stream ${stream.streamId}:`,
            error,
          );
        }
      }

      if (page.length < STREAM_PAGE_SIZE) break;
      cursor = page[page.length - 1]!.streamId;
    }

    logger.info(`[RunwayWorker] Checked ${checked} active streams`);

    const duration = Date.now() - startTime;
    logger.info(
      `[RunwayWorker] Check complete in ${duration}ms. Warnings: ${warningsSent}, Critical: ${criticalsSent}`,
    );
  } catch (error) {
    logger.error("[RunwayWorker] Fatal error during runway check:", error);
  }
}

/**
 * Start the worker with hourly interval
 */
export function startStreamRunwayWorker(): NodeJS.Timeout {
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  // Run immediately on start
  runStreamRunwayCheck().catch((error) => {
    logger.error("[RunwayWorker] Initial run failed:", error);
  });

  // Schedule hourly runs
  const timer = setInterval(() => {
    runStreamRunwayCheck().catch((error) => {
      logger.error("[RunwayWorker] Scheduled run failed:", error);
    });
  }, INTERVAL_MS);

  logger.info("[RunwayWorker] Worker started - running every hour");

  return timer;
}
