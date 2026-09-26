/**
 * Transaction Export Service for Tax & Accounting (Issue #1191)
 * Generates CSV/JSON exports for bookkeeping and tax filings
 */
import type { Response } from "express";
import { prisma } from "../lib/prisma.js";
import logger from "../logger.js";

export interface ExportOptions {
  format: "csv" | "json";
  direction: "incoming" | "outgoing" | "all";
  startDate?: Date | null;
  endDate?: Date | null;
  tokenAddress?: string | null;
}

export interface TransactionRecord {
  timestamp: string;
  streamId: string;
  transactionHash: string;
  eventType: string;
  direction: "OUTGOING" | "INCOMING";
  counterpartyAddress: string;
  tokenContract: string;
  grossAmountStroops: string;
  grossAmountFormatted: string;
  protocolFeeDeducted: string;
  netAmount: string;
}

const CSV_HEADERS = [
  "Timestamp (UTC)",
  "Stream ID",
  "Transaction Hash",
  "Event Type",
  "Direction",
  "Counterparty Address",
  "Token Contract",
  "Gross Amount (Stroops)",
  "Gross Amount (Formatted)",
  "Protocol Fee Deducted",
  "Net Amount",
].join(",");

/**
 * Format amount from stroops (i128) to human-readable decimal
 * Assumes 7 decimals for Stellar tokens
 */
function formatAmount(stroops: string, decimals = 7): string {
  const amount = BigInt(stroops);
  const divisor = BigInt(10 ** decimals);
  const wholePart = amount / divisor;
  const fractionalPart = amount % divisor;

  return `${wholePart}.${fractionalPart.toString().padStart(decimals, "0")}`;
}

/**
 * Calculate protocol fee (simplified - adjust based on actual fee structure)
 */
function calculateProtocolFee(amount: string, eventType: string): string {
  // Example: 0.5% fee on withdrawals
  if (eventType === "WITHDRAWN") {
    const amt = BigInt(amount);
    const fee = (amt * 5n) / 1000n; // 0.5%
    return fee.toString();
  }
  return "0";
}

/**
 * Convert database records to transaction export format
 */
function mapEventToTransaction(
  event: any,
  stream: any,
  userAddress: string,
): TransactionRecord {
  const isOutgoing = stream.sender === userAddress;
  const direction = isOutgoing ? "OUTGOING" : "INCOMING";
  const counterparty = isOutgoing ? stream.recipient : stream.sender;

  const grossAmount = event.amount || "0";
  const protocolFee = calculateProtocolFee(grossAmount, event.eventType);
  const netAmount = (BigInt(grossAmount) - BigInt(protocolFee)).toString();

  return {
    timestamp: new Date(Number(event.timestamp) * 1000).toISOString(),
    streamId: stream.streamId.toString(),
    transactionHash: event.transactionHash,
    eventType: event.eventType,
    direction,
    counterpartyAddress: counterparty,
    tokenContract: stream.tokenAddress,
    grossAmountStroops: grossAmount,
    grossAmountFormatted: formatAmount(grossAmount),
    protocolFeeDeducted: protocolFee,
    netAmount: formatAmount(netAmount),
  };
}

/**
 * Convert transaction record to CSV row
 */
function transactionToCSVRow(record: TransactionRecord): string {
  const escapeCSV = (value: string): string => {
    if (value.includes(",") || value.includes('"') || value.includes("\n")) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };

  return [
    escapeCSV(record.timestamp),
    escapeCSV(record.streamId),
    escapeCSV(record.transactionHash),
    escapeCSV(record.eventType),
    escapeCSV(record.direction),
    escapeCSV(record.counterpartyAddress),
    escapeCSV(record.tokenContract),
    escapeCSV(record.grossAmountStroops),
    escapeCSV(record.grossAmountFormatted),
    escapeCSV(record.protocolFeeDeducted),
    escapeCSV(record.netAmount),
  ].join(",");
}

/**
 * Stream transaction export as CSV
 */
export async function streamTransactionCSV(
  userAddress: string,
  options: ExportOptions,
  res: Response,
): Promise<void> {
  const { direction, startDate, endDate, tokenAddress } = options;

  // Build where clause
  const where: any = {
    OR: [],
  };

  if (direction === "outgoing" || direction === "all") {
    where.OR.push({ sender: userAddress });
  }
  if (direction === "incoming" || direction === "all") {
    where.OR.push({ recipient: userAddress });
  }

  if (tokenAddress) {
    where.tokenAddress = tokenAddress;
  }

  // Set response headers
  const filename = `flowfi-statement-${userAddress}-${new Date().toISOString().split("T")[0]}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Transfer-Encoding", "chunked");

  // Write CSV header
  res.write(CSV_HEADERS + "\n");

  try {
    // Stream data in batches using cursor pagination
    const BATCH_SIZE = 100;
    let cursor: string | undefined;
    let processedCount = 0;

    while (true) {
      const streams = await prisma.stream.findMany({
        where,
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { createdAt: "asc" },
        include: {
          events: {
            where: {
              ...(startDate || endDate
                ? {
                    timestamp: {
                      ...(startDate
                        ? {
                            gte: BigInt(Math.floor(startDate.getTime() / 1000)),
                          }
                        : {}),
                      ...(endDate
                        ? { lte: BigInt(Math.floor(endDate.getTime() / 1000)) }
                        : {}),
                    },
                  }
                : {}),
            },
            orderBy: { timestamp: "asc" },
          },
        },
      });

      if (streams.length === 0) break;

      for (const stream of streams) {
        for (const event of stream.events) {
          const transaction = mapEventToTransaction(event, stream, userAddress);
          const row = transactionToCSVRow(transaction);
          res.write(row + "\n");
          processedCount++;
        }
      }

      const lastStream = streams[streams.length - 1];
      if (lastStream) {
        cursor = lastStream.id;
      }

      if (streams.length < BATCH_SIZE) break;
    }

    res.end();
    logger.info(
      `[Export] CSV export complete: ${processedCount} transactions for ${userAddress}`,
    );
  } catch (error) {
    logger.error("[Export] CSV streaming error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Export failed" });
    }
  }
}

/**
 * Stream transaction export as JSON
 */
export async function streamTransactionJSON(
  userAddress: string,
  options: ExportOptions,
  res: Response,
): Promise<void> {
  const { direction, startDate, endDate, tokenAddress } = options;

  // Build where clause
  const where: any = {
    OR: [],
  };

  if (direction === "outgoing" || direction === "all") {
    where.OR.push({ sender: userAddress });
  }
  if (direction === "incoming" || direction === "all") {
    where.OR.push({ recipient: userAddress });
  }

  if (tokenAddress) {
    where.tokenAddress = tokenAddress;
  }

  // Set response headers
  const filename = `flowfi-statement-${userAddress}-${new Date().toISOString().split("T")[0]}.json`;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Transfer-Encoding", "chunked");

  // Start JSON array
  res.write('{"transactions":[');

  try {
    const BATCH_SIZE = 100;
    let cursor: string | undefined;
    let processedCount = 0;
    let isFirst = true;

    while (true) {
      const streams = await prisma.stream.findMany({
        where,
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { createdAt: "asc" },
        include: {
          events: {
            where: {
              ...(startDate || endDate
                ? {
                    timestamp: {
                      ...(startDate
                        ? {
                            gte: BigInt(Math.floor(startDate.getTime() / 1000)),
                          }
                        : {}),
                      ...(endDate
                        ? { lte: BigInt(Math.floor(endDate.getTime() / 1000)) }
                        : {}),
                    },
                  }
                : {}),
            },
            orderBy: { timestamp: "asc" },
          },
        },
      });

      if (streams.length === 0) break;

      for (const stream of streams) {
        for (const event of stream.events) {
          const transaction = mapEventToTransaction(event, stream, userAddress);

          if (!isFirst) {
            res.write(",");
          }
          res.write(JSON.stringify(transaction));
          isFirst = false;
          processedCount++;
        }
      }

      const lastStream = streams[streams.length - 1];
      if (lastStream) {
        cursor = lastStream.id;
      }

      if (streams.length < BATCH_SIZE) break;
    }

    // Close JSON array and add metadata
    res.write(
      `],"metadata":{"totalRecords":${processedCount},"exportedAt":"${new Date().toISOString()}","userAddress":"${userAddress}"}}`,
    );
    res.end();

    logger.info(
      `[Export] JSON export complete: ${processedCount} transactions for ${userAddress}`,
    );
  } catch (error) {
    logger.error("[Export] JSON streaming error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Export failed" });
    }
  }
}
