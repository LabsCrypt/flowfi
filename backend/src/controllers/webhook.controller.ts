/**
 * Webhook Controller (Issue #1189)
 *
 * Ownership is never taken from the request: every handler derives the wallet
 * address from the authenticated principal (`req.user.publicKey`) and passes it
 * to the service, which scopes its queries by it. A client-supplied
 * `userAddress` is ignored, so quoting someone else's address cannot read,
 * mutate, or mint a signing secret for their subscriptions (issue #1846).
 */
import type { Request, Response } from "express";
import * as webhookService from "../services/webhook.service.js";
import type { AuthenticatedRequest } from "../types/auth.types.js";
import { ApiError, sendApiError } from "../lib/api-error.js";
import logger from "../logger.js";

/**
 * The authenticated wallet, or `null` when the request never passed
 * `requireAuth`. Route-level auth makes that a misconfiguration rather than a
 * client error, but answering 401 is the safe response either way.
 */
function ownerOf(req: Request): string | null {
  const user = (req as Partial<AuthenticatedRequest>).user;
  return user?.publicKey ?? null;
}

function respondError(res: Response, error: unknown, fallback: string): void {
  if (error instanceof ApiError) {
    sendApiError(res, error.statusCode, error.code, error.message, error.details);
    return;
  }
  logger.error(`[Webhook Controller] ${fallback} error:`, error);
  const message = error instanceof Error ? error.message : "Unknown error";
  sendApiError(res, 500, "INTERNAL_SERVER_ERROR", message);
}

export async function createWebhook(req: Request, res: Response): Promise<void> {
  const userAddress = ownerOf(req);
  if (!userAddress) {
    sendApiError(res, 401, "UNAUTHORIZED", "Authentication required");
    return;
  }

  try {
    const { targetUrl, eventTypes } = req.body ?? {};

    if (!targetUrl || !Array.isArray(eventTypes)) {
      sendApiError(
        res,
        400,
        "WEBHOOK_INVALID_REQUEST",
        "Missing required fields: targetUrl, eventTypes",
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
  } catch (error) {
    respondError(res, error, "create");
  }
}

export async function listWebhooks(req: Request, res: Response): Promise<void> {
  const userAddress = ownerOf(req);
  if (!userAddress) {
    sendApiError(res, 401, "UNAUTHORIZED", "Authentication required");
    return;
  }

  try {
    const subscriptions =
      await webhookService.listWebhookSubscriptions(userAddress);

    // Don't expose secret keys
    const safeSubscriptions = subscriptions.map(
      ({ secretKey: _secretKey, ...rest }) => rest,
    );

    res.json({ subscriptions: safeSubscriptions });
  } catch (error) {
    respondError(res, error, "list");
  }
}

export async function deleteWebhook(req: Request, res: Response): Promise<void> {
  const userAddress = ownerOf(req);
  if (!userAddress) {
    sendApiError(res, 401, "UNAUTHORIZED", "Authentication required");
    return;
  }

  try {
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;

    if (!id) {
      sendApiError(res, 400, "WEBHOOK_INVALID_REQUEST", "Invalid id");
      return;
    }

    await webhookService.deleteWebhookSubscription(id, userAddress);

    res.status(204).send();
  } catch (error) {
    respondError(res, error, "delete");
  }
}

export async function updateWebhook(req: Request, res: Response): Promise<void> {
  const userAddress = ownerOf(req);
  if (!userAddress) {
    sendApiError(res, 401, "UNAUTHORIZED", "Authentication required");
    return;
  }

  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      sendApiError(res, 400, "WEBHOOK_INVALID_REQUEST", "id is required");
      return;
    }
    // A `userAddress` in the body is dropped: the owner comes from the token.
    const { userAddress: _ignored, ...input } = req.body ?? {};
    const subscription = await webhookService.updateWebhookSubscription(id, userAddress, input);
    res.json(subscription);
  } catch (error) {
    respondError(res, error, "update");
  }
}

export async function listDeliveries(req: Request, res: Response): Promise<void> {
  const userAddress = ownerOf(req);
  if (!userAddress) {
    sendApiError(res, 401, "UNAUTHORIZED", "Authentication required");
    return;
  }

  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      sendApiError(res, 400, "WEBHOOK_INVALID_REQUEST", "id is required");
      return;
    }
    const page = req.query.page;
    const limit = req.query.limit;
    res.json(await webhookService.listWebhookDeliveries(
      id,
      userAddress,
      Number(page ?? 1),
      Number(limit ?? 20),
    ));
  } catch (error) {
    respondError(res, error, "list deliveries");
  }
}

export async function regenerateSecret(req: Request, res: Response): Promise<void> {
  const userAddress = ownerOf(req);
  if (!userAddress) {
    sendApiError(res, 401, "UNAUTHORIZED", "Authentication required");
    return;
  }

  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      sendApiError(res, 400, "WEBHOOK_INVALID_REQUEST", "id is required");
      return;
    }
    res.json({ secretKey: await webhookService.regenerateWebhookSecret(id, userAddress) });
  } catch (error) {
    respondError(res, error, "regenerate secret");
  }
}

export async function testWebhook(req: Request, res: Response): Promise<void> {
  const userAddress = ownerOf(req);
  if (!userAddress) {
    sendApiError(res, 401, "UNAUTHORIZED", "Authentication required");
    return;
  }

  try {
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;

    if (!id) {
      sendApiError(res, 400, "WEBHOOK_INVALID_REQUEST", "id required");
      return;
    }

    const result = await webhookService.sendTestWebhook(id, userAddress);

    res.json({
      message: "Test webhook sent",
      result,
    });
  } catch (error) {
    respondError(res, error, "test");
  }
}
