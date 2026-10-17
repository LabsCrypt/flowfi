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

router.get("/tvl", getTvlHandler);
router.get("/historical", getHistoricalHandler);
router.get("/defillama", getDefiLlamaHandler);

export default router;
