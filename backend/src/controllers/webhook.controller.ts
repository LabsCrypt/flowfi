/**
 * Webhook Controller (Issue #1189)
 */
import type { Request, Response } from "express";
import * as webhookService from "../services/webhook.service.js";
import logger from "../logger.js";

export async function createWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { userAddress, targetUrl, eventTypes } = req.body;

    if (!userAddress || !targetUrl || !Array.isArray(eventTypes)) {
      res.status(400).json({
        error: "Missing required fields: userAddress, targetUrl, eventTypes",
      });
      return;
    }

    const subscription = await webhookService.createWebhookSubscription(
      userAddress,
      targetUrl,
      eventTypes,
    );

    // Don't expose the secret key in response
    const { secretKey, ...safeSubscription } = subscription;

    res.status(201).json({
      subscription: safeSubscription,
      secretKey, // Only returned once on creation
      message: "Store the secret key securely - it will not be shown again",
    });
  } catch (error: unknown) {
    logger.error("[Webhook Controller] Create error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to create webhook",
    });
  }
}

export async function listWebhooks(req: Request, res: Response): Promise<void> {
  try {
    const { userAddress } = req.query;

    if (!userAddress || typeof userAddress !== "string") {
      res.status(400).json({ error: "userAddress query parameter required" });
      return;
    }

    const subscriptions =
      await webhookService.listWebhookSubscriptions(userAddress);

    // Don't expose secret keys
    const safeSubscriptions = subscriptions.map(
      ({ secretKey: _secretKey, ...rest }) => rest,
    );

    res.json({ subscriptions: safeSubscriptions });
  } catch (error: unknown) {
    logger.error("[Webhook Controller] List error:", error);
    res.status(500).json({ error: "Failed to list webhooks" });
  }
}

export async function deleteWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const { userAddress } = req.query;

    if (!id || !userAddress || typeof userAddress !== "string") {
      res.status(400).json({ error: "Invalid id or userAddress required" });
      return;
    }

    await webhookService.deleteWebhookSubscription(id, userAddress);

    res.status(204).send();
  } catch (error: unknown) {
    logger.error("[Webhook Controller] Delete error:", error);
    res.status(500).json({ error: "Failed to delete webhook" });
  }
}

export async function testWebhook(req: Request, res: Response): Promise<void> {
  try {
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const { userAddress } = req.body;

    if (!id || !userAddress) {
      res.status(400).json({ error: "id and userAddress required" });
      return;
    }

    const result = await webhookService.sendTestWebhook(id, userAddress);

    res.json({
      message: "Test webhook sent",
      result,
    });
  } catch (error: unknown) {
    logger.error("[Webhook Controller] Test error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to send test webhook",
    });
  }
}
