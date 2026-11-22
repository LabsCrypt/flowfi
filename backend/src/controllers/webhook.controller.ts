/**
 * Webhook Controller (Issue #1189)
 */
import type { Request, Response } from "express";
import * as webhookService from "../services/webhook.service.js";
import logger from "../logger.js";
import { sanitizeDatabaseErrorMessage, sendApiError } from "../lib/api-error.js";

export async function createWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { userAddress, targetUrl, eventTypes } = req.body;

    if (!userAddress || !targetUrl || !Array.isArray(eventTypes)) {
      sendApiError(
        res,
        400,
        "WEBHOOK_INVALID_REQUEST",
        "Missing required fields: userAddress, targetUrl, eventTypes",
      );
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
  } catch (error: any) {
    logger.error("[Webhook Controller] Create error:", error);
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      sanitizeDatabaseErrorMessage(error?.message ?? "", 500) || "Failed to create webhook",
    );
  }
}

export async function listWebhooks(req: Request, res: Response): Promise<void> {
  try {
    const { userAddress } = req.query;

    if (!userAddress || typeof userAddress !== "string") {
      sendApiError(res, 400, "WEBHOOK_INVALID_REQUEST", "userAddress query parameter required");
      return;
    }

    const subscriptions =
      await webhookService.listWebhookSubscriptions(userAddress);

    // Don't expose secret keys
    const safeSubscriptions = subscriptions.map(
      ({ secretKey, ...rest }) => rest,
    );

    res.json({ subscriptions: safeSubscriptions });
  } catch (error: any) {
    logger.error("[Webhook Controller] List error:", error);
    sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Failed to list webhooks");
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
      sendApiError(res, 400, "WEBHOOK_INVALID_REQUEST", "Invalid id or userAddress required");
      return;
    }

    await webhookService.deleteWebhookSubscription(id, userAddress);

    res.status(204).send();
  } catch (error: any) {
    logger.error("[Webhook Controller] Delete error:", error);
    sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Failed to delete webhook");
  }
}

export async function updateWebhook(req: Request, res: Response): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { userAddress } = req.query;
    if (!id || typeof userAddress !== "string") {
      sendApiError(res, 400, "WEBHOOK_INVALID_REQUEST", "id and userAddress are required");
      return;
    }
    const subscription = await webhookService.updateWebhookSubscription(id, userAddress, req.body);
    res.json(subscription);
  } catch (error: any) {
    logger.warn("[Webhook Controller] Failed to update webhook:", error);
    sendApiError(
      res,
      400,
      "WEBHOOK_INVALID_REQUEST",
      sanitizeDatabaseErrorMessage(error?.message ?? "", 400) || "Failed to update webhook",
    );
  }
}

export async function listDeliveries(req: Request, res: Response): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { userAddress, page = "1", limit = "20" } = req.query;
    if (!id || typeof userAddress !== "string") {
      sendApiError(res, 400, "WEBHOOK_INVALID_REQUEST", "id and userAddress are required");
      return;
    }
    res.json(await webhookService.listWebhookDeliveries(id, userAddress, Number(page), Number(limit)));
  } catch (error: any) {
    logger.warn("[Webhook Controller] Failed to update webhook:", error);
    sendApiError(
      res,
      400,
      "WEBHOOK_INVALID_REQUEST",
      sanitizeDatabaseErrorMessage(error?.message ?? "", 400) || "Failed to update webhook",
    );
  }
}

export async function regenerateSecret(req: Request, res: Response): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { userAddress } = req.body;
    if (!id || !userAddress) {
      sendApiError(res, 400, "WEBHOOK_INVALID_REQUEST", "id and userAddress are required");
      return;
    }
    res.json({ secretKey: await webhookService.regenerateWebhookSecret(id, userAddress) });
  } catch (error: any) {
    logger.warn("[Webhook Controller] Failed to update webhook:", error);
    sendApiError(
      res,
      400,
      "WEBHOOK_INVALID_REQUEST",
      sanitizeDatabaseErrorMessage(error?.message ?? "", 400) || "Failed to update webhook",
    );
  }
}

export async function testWebhook(req: Request, res: Response): Promise<void> {
  try {
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const { userAddress } = req.body;

    if (!id || !userAddress) {
      sendApiError(res, 400, "WEBHOOK_INVALID_REQUEST", "id and userAddress required");
      return;
    }

    const result = await webhookService.sendTestWebhook(id, userAddress);

    res.json({
      message: "Test webhook sent",
      result,
    });
  } catch (error: any) {
    logger.error("[Webhook Controller] Test error:", error);
    sendApiError(
      res,
      500,
      "INTERNAL_SERVER_ERROR",
      sanitizeDatabaseErrorMessage(error?.message ?? "", 500) || "Failed to create webhook",
    );
  }
}
