import { Router } from "express";
import streamRoutes from "./streams/index.js";
import eventsRoutes from "./events.routes.js";
import userRoutes from "./user.routes.js";
import authRoutes from "./auth.routes.js";
import adminRoutes from "./admin.routes.js";
import webhookRoutes from "./webhook.routes.js";
import analyticsRoutes from "./analytics.routes.js";

const router = Router();

// V1 API Routes
router.use("/streams", streamRoutes);
router.use("/events", eventsRoutes);
router.use("/users", userRoutes);
router.use("/auth", authRoutes);
router.use("/webhooks", webhookRoutes);
router.use("/analytics", analyticsRoutes);

// Admin routes
router.use("/admin", adminRoutes);

export default router;
