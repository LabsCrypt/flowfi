/**
 * Outgoing Webhook Event Dispatcher with HMAC Signature (Issue #1189)
 * Delivers real-time HTTP POST notifications for stream events
 */
import crypto from "crypto";
import { prisma } from "../lib/prisma.js";
import logger from "../logger.js";

export interface WebhookSubscription {
  id: string;
  userAddress: string;
  targetUrl: string;
  secretKey: string;
  eventTypes: string[];
  isActive: boolean;
}

export interface WebhookPayload {
  eventType: string;
  data: Record<string, any>;
  timestamp: string;
}

const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [0, 60000, 300000, 900000, 3600000]; // 0, 1m, 5m, 15m, 1h

/**
 * Generate HMAC-SHA256 signature for webhook payload
 */
export function generateWebhookSignature(
  payload: string,
  secret: string,
  timestamp: number,
): string {
  const signaturePayload = `${timestamp}.${payload}`;
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(signaturePayload);
  return hmac.digest("hex");
}

/**
 * Verify webhook signature
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
  timestamp: number,
  toleranceSeconds = 300,
): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return false;
  }

  const expectedSignature = generateWebhookSignature(
    payload,
    secret,
    timestamp,
  );
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature),
  );
}

/**
 * Create webhook subscription
 */
export async function createWebhookSubscription(
  userAddress: string,
  targetUrl: string,
  eventTypes: string[],
): Promise<WebhookSubscription> {
  // Validate HTTPS
  if (!targetUrl.startsWith("https://")) {
    throw new Error("Webhook URL must use HTTPS");
  }

  // Generate secure secret
  const secretKey = crypto.randomBytes(32).toString("hex");

  const subscription = await prisma.webhookSubscription.create({
    data: {
      userAddress,
      targetUrl,
      secretKey,
      eventTypes,
      isActive: true,
    },
  });

  return subscription as WebhookSubscription;
}

/**
 * List webhook subscriptions for user
 */
export async function listWebhookSubscriptions(
  userAddress: string,
): Promise<WebhookSubscription[]> {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: {
      userAddress,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return subscriptions as WebhookSubscription[];
}

/**
 * Delete webhook subscription
 */
export async function deleteWebhookSubscription(
  id: string,
  userAddress: string,
): Promise<void> {
  await prisma.webhookSubscription.updateMany({
    where: {
      id,
      userAddress, // Ensure user owns this webhook
    },
    data: {
      isActive: false,
    },
  });
}

export async function updateWebhookSubscription(
  id: string,
  userAddress: string,
  input: { targetUrl?: string; eventTypes?: string[]; isActive?: boolean },
): Promise<Omit<WebhookSubscription, "secretKey">> {
  if (input.targetUrl !== undefined && !input.targetUrl.startsWith("https://")) {
    throw new Error("Webhook URL must use HTTPS");
  }
  const subscription = await prisma.webhookSubscription.updateMany({
    where: { id, userAddress },
    data: input,
  });
  if (subscription.count === 0) throw new Error("Webhook subscription not found");
  const updated = await prisma.webhookSubscription.findUniqueOrThrow({ where: { id } });
  const { secretKey: _secretKey, ...safe } = updated;
  return safe;
}

export async function listWebhookDeliveries(
  id: string,
  userAddress: string,
  page: number,
  limit: number,
) {
  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit) || 20));
  const subscription = await prisma.webhookSubscription.findFirst({ where: { id, userAddress } });
  if (!subscription) throw new Error("Webhook subscription not found");
  const [deliveries, total] = await Promise.all([
    prisma.webhookDelivery.findMany({
      where: { subscriptionId: id },
      orderBy: { createdAt: "desc" },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    }),
    prisma.webhookDelivery.count({ where: { subscriptionId: id } }),
  ]);
  return { deliveries, total, page: safePage, limit: safeLimit };
}

export async function regenerateWebhookSecret(id: string, userAddress: string): Promise<string> {
  const owned = await prisma.webhookSubscription.findFirst({ where: { id, userAddress } });
  if (!owned) throw new Error("Webhook subscription not found");
  const secretKey = crypto.randomBytes(32).toString("hex");
  await prisma.webhookSubscription.update({ where: { id }, data: { secretKey } });
  return secretKey;
}

export interface DeliveryResult {
  success: boolean;
  status?: number;
  error?: string;
}

export interface TestWebhookResult extends DeliveryResult {
  /** Round-trip time of the single test dispatch, in milliseconds. */
  latencyMs: number;
}

/**
 * Send test webhook ping (issue #1645)
 *
 * Dispatches a signed synthetic payload with `eventType: "webhook.test"` and
 * reports the upstream HTTP status plus round-trip latency. A test ping makes
 * a single attempt — the multi-hour retry ladder of production delivery is
 * not useful when a human is waiting on the result — and never touches the
 * consecutive-failure counter.
 */
export async function sendTestWebhook(
  id: string,
  userAddress: string,
): Promise<TestWebhookResult> {
  const subscription = await prisma.webhookSubscription.findFirst({
    where: {
      id,
      userAddress,
      isActive: true,
    },
  });

  if (!subscription) {
    throw new Error("Webhook subscription not found");
  }

  const testPayload: WebhookPayload = {
    eventType: "webhook.test",
    data: {
      webhookId: subscription.id,
      message: "This is a test webhook delivery from FlowFi",
    },
    timestamp: new Date().toISOString(),
  };

  const startedAt = Date.now();
  const result = await deliverWebhook(subscription as WebhookSubscription, testPayload, {
    retries: false,
  });
  return { ...result, latencyMs: Date.now() - startedAt };
}

/**
 * Deliver webhook with retry logic
 */
export async function deliverWebhook(
  subscription: WebhookSubscription,
  payload: WebhookPayload,
  options: { retries?: boolean } = {},
): Promise<DeliveryResult> {
  const retryEnabled = options.retries !== false;
  const maxAttempts = retryEnabled ? MAX_RETRY_ATTEMPTS : 1;
  const payloadJson = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = generateWebhookSignature(
    payloadJson,
    subscription.secretKey,
    timestamp,
  );

  const deliveryId = crypto.randomUUID();

  // Create delivery record
  const delivery = await prisma.webhookDelivery.create({
    data: {
      subscriptionId: subscription.id,
      eventType: payload.eventType,
      payload: payloadJson,
      attempts: 0,
    },
  });

  let lastError: string | undefined;
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Wait for retry delay
      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAYS_MS[attempt]),
        );
      }

      const response = await fetch(subscription.targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-FlowFi-Signature": `t=${timestamp},v1=${signature}`,
          "X-FlowFi-Event": payload.eventType,
          "X-FlowFi-Delivery-ID": deliveryId,
          "User-Agent": "FlowFi-Webhook/1.0",
        },
        body: payloadJson,
        signal: AbortSignal.timeout(10000), // 10s timeout
      });

      lastStatus = response.status;

      // Update delivery record
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          responseStatus: lastStatus,
          attempts: attempt + 1,
          deliveredAt:
            lastStatus >= 200 && lastStatus < 300 ? new Date() : null,
          error:
            lastStatus >= 200 && lastStatus < 300 ? null : `HTTP ${lastStatus}`,
        },
      });

      if (lastStatus >= 200 && lastStatus < 300) {
        logger.info(
          `[Webhook] Successfully delivered ${payload.eventType} to ${subscription.targetUrl} (attempt ${attempt + 1})`,
        );
        return { success: true, status: lastStatus };
      }

      lastError = `HTTP ${lastStatus}`;
      logger.warn(
        `[Webhook] Delivery failed with status ${lastStatus} (attempt ${attempt + 1}/${maxAttempts})`,
      );
    } catch (error: any) {
      lastError = error.message || "Network error";
      logger.warn(
        `[Webhook] Delivery error: ${lastError} (attempt ${attempt + 1}/${maxAttempts})`,
      );

      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          attempts: attempt + 1,
          error: lastError || null,
        },
      });
    }
  }

  // All retries exhausted - check if we should disable webhook. A single
  // test dispatch never counts toward auto-disable (issue #1645).
  if (retryEnabled) {
    await checkConsecutiveFailures(subscription.id);
  }

  return {
    success: false,
    status: lastStatus || 0,
    error: lastError || "Unknown error",
  };
}

/**
 * Check consecutive failures and disable webhook if threshold exceeded
 */
async function checkConsecutiveFailures(subscriptionId: string): Promise<void> {
  const recentDeliveries = await prisma.webhookDelivery.findMany({
    where: {
      subscriptionId,
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 50,
  });

  let consecutiveFailures = 0;
  for (const delivery of recentDeliveries) {
    if (delivery.deliveredAt === null) {
      consecutiveFailures++;
    } else {
      break;
    }
  }

  if (consecutiveFailures >= 50) {
    await prisma.webhookSubscription.update({
      where: { id: subscriptionId },
      data: { isActive: false },
    });

    logger.warn(
      `[Webhook] Disabled subscription ${subscriptionId} after 50 consecutive failures`,
    );
  }
}

/**
 * Dispatch webhook to all subscribers for an event
 */
export async function dispatchWebhookEvent(
  eventType: string,
  data: Record<string, any>,
  userAddresses: string[],
): Promise<void> {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: {
      userAddress: {
        in: userAddresses,
      },
      isActive: true,
      eventTypes: {
        has: eventType,
      },
    },
  });

  const payload: WebhookPayload = {
    eventType,
    data,
    timestamp: new Date().toISOString(),
  };

  // Dispatch to all subscriptions in parallel
  const deliveries = subscriptions.map((subscription) =>
    deliverWebhook(subscription as WebhookSubscription, payload).catch(
      (error) => {
        logger.error(
          `[Webhook] Failed to deliver to ${subscription.targetUrl}:`,
          error,
        );
      },
    ),
  );

  await Promise.all(deliveries);
}
