/**
 * Analytics routes (#1480) — public protocol statistics.
 *
 * - GET /tvl        — current TVL partitioned by token
 * - GET /historical — pre-aggregated chart series (`?period=&interval=`)
 * - GET /defillama  — DefiLlama adapter payload
 */

import { Router } from "express";
import {
  getDefiLlamaHandler,
  getHistoricalHandler,
  getTvlHandler,
} from "../../controllers/analytics.controller.js";

const router = Router();

/**
 * @openapi
 * /v1/analytics/tvl:
 *   get:
 *     tags:
 *       - Analytics
 *     summary: Current protocol TVL partitioned by token asset
 *     description: |
 *       Read-only protocol statistics. No authentication is required because
 *       every payload here is public (the same numbers a block explorer
 *       would show). Subject to the API's global rate limiter.
 *     responses:
 *       200:
 *         description: TVL snapshot
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   description: Current TVL snapshot partitioned by token asset
 *       429:
 *         description: Too many requests
 *       500:
 *         description: TVL snapshot unavailable
 */
router.get("/tvl", getTvlHandler);

/**
 * @openapi
 * /v1/analytics/historical:
 *   get:
 *     tags:
 *       - Analytics
 *     summary: Pre-aggregated time-series points for frontend charts
 *     description: |
 *       Historical TVL and volume series at a fixed interval. No
 *       authentication is required; subject to the API's global rate limiter.
 *     parameters:
 *       - in: query
 *         name: period
 *         required: false
 *         schema:
 *           type: string
 *           enum: [7d, 30d, 90d, 1y]
 *           default: 30d
 *         description: Lookback window
 *       - in: query
 *         name: interval
 *         required: false
 *         schema:
 *           type: string
 *           enum: [1h, 1d]
 *           default: 1d
 *         description: Granularity of each point
 *     responses:
 *       200:
 *         description: Time-series points
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   description: Aggregated time-series points for the requested period and interval
 *       400:
 *         description: Invalid period or interval
 *       429:
 *         description: Too many requests
 *       500:
 *         description: Historical analytics unavailable
 */
router.get("/historical", getHistoricalHandler);

/**
 * @openapi
 * /v1/analytics/defillama:
 *   get:
 *     tags:
 *       - Analytics
 *     summary: DefiLlama adapter payload
 *     description: |
 *       TVL and activity numbers in the shape DefiLlama's adapter format
 *       expects, so the protocol can be listed without a separate adapter.
 *       No authentication is required; subject to the global rate limiter.
 *     responses:
 *       200:
 *         description: DefiLlama adapter payload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [success, data]
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   description: DefiLlama-shaped adapter payload
 *       429:
 *         description: Too many requests
 *       500:
 *         description: DefiLlama adapter unavailable
 */
router.get("/defillama", getDefiLlamaHandler);

export default router;
