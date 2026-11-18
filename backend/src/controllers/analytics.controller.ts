/**
 * Analytics controller — HTTP surface for the #1480 analytics stack.
 *
 * Read-only endpoints; no auth beyond the API's global middleware because
 * every payload here is public protocol statistics (the same numbers a
 * block explorer would show).
 */

import type { Request, Response } from "express";
import {
  getDefiLlamaAdapter,
  getHistoricalAnalytics,
  getProtocolTvl,
  type AnalyticsInterval,
  type AnalyticsPeriod,
} from "../services/analytics.service.js";
import { sendApiError } from "../types/api-error.js";
import logger from "../logger.js";

const VALID_PERIODS: AnalyticsPeriod[] = ["7d", "30d", "90d", "1y"];
const VALID_INTERVALS: AnalyticsInterval[] = ["1h", "1d"];

/**
 * GET /api/v1/analytics/tvl
 *
 * Current protocol TVL partitioned by token asset.
 */
export async function getTvlHandler(_req: Request, res: Response) {
  try {
    const snapshot = await getProtocolTvl();
    res.json({ success: true, data: snapshot });
  } catch (error) {
    logger.error("analytics TVL request failed:", error);
    sendApiError(res, 500, "ANALYTICS_UNAVAILABLE", "TVL snapshot unavailable");
  }
}

/**
 * GET /api/v1/analytics/historical?period=30d&interval=1d
 *
 * Pre-aggregated time-series points for frontend charts.
 */
export async function getHistoricalHandler(req: Request, res: Response) {
  const period = (req.query.period ?? "30d") as AnalyticsPeriod;
  const interval = (req.query.interval ?? "1d") as AnalyticsInterval;

  if (!VALID_PERIODS.includes(period)) {
    sendApiError(
      res,
      400,
      "INVALID_PERIOD",
      `period must be one of: ${VALID_PERIODS.join(", ")}`
    );
    return;
  }
  if (!VALID_INTERVALS.includes(interval)) {
    sendApiError(
      res,
      400,
      "INVALID_INTERVAL",
      `interval must be one of: ${VALID_INTERVALS.join(", ")}`
    );
    return;
  }

  try {
    const series = await getHistoricalAnalytics(period, interval);
    res.json({ success: true, data: series });
  } catch (error) {
    logger.error("analytics historical request failed:", error);
    sendApiError(
      res,
      500,
      "ANALYTICS_UNAVAILABLE",
      "Historical analytics unavailable"
    );
  }
}

/**
 * GET /api/v1/analytics/defillama
 *
 * Standardized DefiLlama protocol-TVL adapter response.
 */
export async function getDefiLlamaHandler(_req: Request, res: Response) {
  try {
    const adapter = await getDefiLlamaAdapter();
    // DefiLlama consumes the raw object; no success envelope here.
    res.json(adapter);
  } catch (error) {
    logger.error("DefiLlama adapter request failed:", error);
    sendApiError(
      res,
      500,
      "ANALYTICS_UNAVAILABLE",
      "DefiLlama adapter unavailable"
    );
  }
}
