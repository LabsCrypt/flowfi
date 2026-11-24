import { Router } from "express";
import streamRoutes from "./streams/index.js";
import eventsRoutes from "./events.routes.js";
import userRoutes from "./user.routes.js";
import authRoutes from "./auth.routes.js";
import adminRoutes from "./admin.routes.js";
import webhookRoutes from "./webhook.routes.js";
import complianceRoutes from "./compliance.routes.js";
import analyticsRoutes from "./analytics.routes.js";
import tokenRoutes from "./token.routes.js";

const router = Router();

// V1 API Routes
router.use("/streams", streamRoutes);
router.use("/events", eventsRoutes);
router.use("/users", userRoutes);
router.use("/auth", authRoutes);
router.use("/webhooks", webhookRoutes);
router.use("/compliance", complianceRoutes);
router.use("/analytics", analyticsRoutes);
router.use("/tokens", tokenRoutes);

// Admin routes
router.use("/admin", adminRoutes);

export default router;
