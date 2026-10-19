/**
 * Webhook test-dispatch tests (issue #1645).
 *
 * `POST /v1/webhooks/:id/test` must send a signed synthetic payload with
 * `eventType: "webhook.test"`, verify ownership of the subscription, make a
 * single attempt (no retry ladder), and report the upstream HTTP status plus
 * round-trip latency. Prisma is mocked; `fetch` is stubbed per test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const findFirstMock = vi.fn();
const createDeliveryMock = vi.fn();
const updateDeliveryMock = vi.fn();
const findManyMock = vi.fn();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    webhookSubscription: { findFirst: (...a: unknown[]) => findFirstMock(...a) },
    webhookDelivery: {
      create: (...a: unknown[]) => createDeliveryMock(...a),
      update: (...a: unknown[]) => updateDeliveryMock(...a),
      findMany: (...a: unknown[]) => findManyMock(...a),
    },
  },
}));

vi.mock("../src/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sendTestWebhook } from "../src/services/webhook.service.js";

const SUBSCRIPTION = {
  id: "wh_1",
  userAddress: "G-OWNER",
  targetUrl: "https://receiver.example/hook",
  secretKey: "super-secret",
  eventTypes: ["*"],
  isActive: true,
};

describe("sendTestWebhook (#1645)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    findManyMock.mockResolvedValue([]);
    createDeliveryMock.mockResolvedValue({ id: "del_1" });
    updateDeliveryMock.mockResolvedValue({});
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a signed 'webhook.test' payload and reports status and latency", async () => {
    findFirstMock.mockResolvedValue(SUBSCRIPTION);
    fetchMock.mockResolvedValue({ status: 200 });

    const result = await sendTestWebhook("wh_1", "G-OWNER");

    expect(result).toMatchObject({ success: true, status: 200 });
    expect(result.latencyMs).toBeTypeOf("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    // Single attempt: the production retry ladder must not run for test pings.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SUBSCRIPTION.targetUrl);

    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(String(init.body));
    expect(body.eventType).toBe("webhook.test");
    expect(body.data.webhookId).toBe("wh_1");
    expect(body.data.message).toBeTypeOf("string");
    expect(body.timestamp).toBeTypeOf("string");
    expect(headers["X-FlowFi-Event"]).toBe("webhook.test");
    expect(headers["X-FlowFi-Signature"]).toMatch(/^t=\d+,v1=[0-9a-f]+$/);
  });

  it("rejects a subscription the caller does not own", async () => {
    findFirstMock.mockResolvedValue(null);

    await expect(sendTestWebhook("wh_1", "G-STRANGER")).rejects.toThrow(
      /not found/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not count a failed test ping toward auto-disable", async () => {
    findFirstMock.mockResolvedValue(SUBSCRIPTION);
    fetchMock.mockResolvedValue({ status: 500 });

    const result = await sendTestWebhook("wh_1", "G-OWNER");

    expect(result.success).toBe(false);
    expect(result.status).toBe(500);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // No consecutive-failure accounting for single test dispatches.
    expect(findManyMock).not.toHaveBeenCalled();
  });
});
