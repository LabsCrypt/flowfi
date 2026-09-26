/**
 * Stream Runway & Low-Balance Alert Engine (Issue #1190)
 * Monitors active streams and generates proactive notifications before funds run out
 */
import { prisma } from "../lib/prisma.js";
import logger from "../logger.js";
import { claimableAmountService } from "../services/claimable.service.js";
import { sseService } from "../services/sse.service.js";

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
function calculateStreamRunway(stream: any, now: number): RunwayCalculation {
  const result = claimableAmountService.getClaimableAmount(
    {
      streamId: stream.streamId,
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
async function wasAlertRecentlySent(
  streamId: bigint,
  alertType: string,
): Promise<boolean> {
  const cutoff = new Date(
    Date.now() - DEDUPLICATION_WINDOW_HOURS * 60 * 60 * 1000,
  );

  const recent = await prisma.alertHistory.findFirst({
    where: {
      streamId,
      alertType,
      sentAt: {
        gte: cutoff,
      },
    },
  });

  return !!recent;
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
    // Fetch all active, unpaused streams
    const activeStreams = await prisma.stream.findMany({
      where: {
        isActive: true,
        isPaused: false,
      },
    });

    logger.info(
      `[RunwayWorker] Checking ${activeStreams.length} active streams`,
    );

    const now = Math.floor(Date.now() / 1000);
    let warningsSent = 0;
    let criticalsSent = 0;

    for (const stream of activeStreams) {
      try {
        const runway = calculateStreamRunway(stream, now);

        // Check critical threshold (24 hours)
        if (runway.remainingRunwaySeconds <= CRITICAL_THRESHOLD_HOURS * 3600) {
          const alreadySent = await wasAlertRecentlySent(
            stream.streamId,
            "CRITICAL_24H",
          );

          if (!alreadySent) {
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
          const alreadySent = await wasAlertRecentlySent(
            stream.streamId,
            "WARNING_48H",
          );

          if (!alreadySent) {
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
