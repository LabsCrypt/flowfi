/**
 * Webhook subscription management routes (Issue #1189)
 */
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import * as webhookController from "../../controllers/webhook.controller.js";

const router = Router();

/**
 * @openapi
 * /v1/webhooks:
 *   post:
 *     summary: Register a new webhook subscription
 *     description: Creates a webhook subscription. The returned `secretKey` is only shown once.
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - targetUrl
 *               - eventTypes
 *             properties:
 *               targetUrl:
 *                 type: string
 *                 format: uri
 *               eventTypes:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [CREATED, TOPPED_UP, WITHDRAWN, CANCELLED, COMPLETED, PAUSED, RESUMED, FEE_COLLECTED]
 *     responses:
 *       201:
 *         description: Webhook created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 subscription:
 *                   $ref: '#/components/schemas/WebhookSubscription'
 *                 secretKey:
 *                   type: string
 *                   description: Webhook signing secret (returned only once)
 *                 message:
 *                   type: string
 *       400:
 *         description: Missing required fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized - missing or invalid authentication
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/", requireAuth, webhookController.createWebhook);

/**
 * @openapi
 * /v1/webhooks:
 *   get:
 *     summary: List all webhooks for the authenticated wallet
 *     description: Subscriptions are scoped to the authenticated wallet; the caller supplies no address.
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of webhook subscriptions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 subscriptions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/WebhookSubscription'
 *       401:
 *         description: Unauthorized - missing or invalid authentication
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get("/", requireAuth, webhookController.listWebhooks);

/**
 * @openapi
 * /v1/webhooks/{id}:
 *   delete:
 *     summary: Delete a webhook subscription
 *     description: Only the subscription owner can delete it; a foreign id is reported as not found.
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Webhook deleted successfully
 *       401:
 *         description: Unauthorized - missing or invalid authentication
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Webhook subscription not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.delete("/:id", requireAuth, webhookController.deleteWebhook);

router.patch("/:id", requireAuth, webhookController.updateWebhook);
router.post("/:id/secret", requireAuth, webhookController.regenerateSecret);
router.get("/:id/deliveries", requireAuth, webhookController.listDeliveries);

/**
 * @openapi
 * /v1/webhooks/{id}/test:
 *   post:
 *     summary: Send a test ping to a webhook
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Test webhook sent
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Test webhook sent
 *                 result:
 *                   type: object
 *                   additionalProperties: true
 *       401:
 *         description: Unauthorized - missing or invalid authentication
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Webhook subscription not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/:id/test", requireAuth, webhookController.testWebhook);

export default router;
