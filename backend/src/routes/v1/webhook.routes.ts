/**
 * Webhook subscription management routes (Issue #1189)
 */
import { Router } from "express";
import * as webhookController from "../../controllers/webhook.controller.js";

const router = Router();

/**
 * @openapi
 * /v1/webhooks:
 *   post:
 *     summary: Register a new webhook subscription
 *     description: Creates a webhook subscription. The returned `secretKey` is only shown once.
 *     tags: [Webhooks]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userAddress
 *               - targetUrl
 *               - eventTypes
 *             properties:
 *               userAddress:
 *                 type: string
 *                 description: Stellar public key
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
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/", webhookController.createWebhook);

/**
 * @openapi
 * /v1/webhooks:
 *   get:
 *     summary: List all webhooks for authenticated user
 *     tags: [Webhooks]
 *     parameters:
 *       - in: query
 *         name: userAddress
 *         required: true
 *         schema:
 *           type: string
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
 *       400:
 *         description: Missing userAddress
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
router.get("/", webhookController.listWebhooks);

/**
 * @openapi
 * /v1/webhooks/{id}:
 *   delete:
 *     summary: Delete a webhook subscription
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: userAddress
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Webhook deleted successfully
 *       400:
 *         description: Invalid id or missing userAddress
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
router.delete("/:id", webhookController.deleteWebhook);

/**
 * @openapi
 * /v1/webhooks/{id}/test:
 *   post:
 *     summary: Send a test ping to a webhook
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userAddress
 *             properties:
 *               userAddress:
 *                 type: string
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
 *       400:
 *         description: Missing id or userAddress
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
router.post("/:id/test", webhookController.testWebhook);

export default router;
