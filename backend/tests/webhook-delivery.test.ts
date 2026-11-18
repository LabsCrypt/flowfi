import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    webhookSubscription: { update: vi.fn() },
    webhookDelivery: { create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../src/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  deliverWebhook,
  verifyWebhookSignature,
} from "../src/services/webhook.service.js";

const SUBSCRIPTION = {
  id: "wh_1",
  userAddress: "G-OWNER",
  targetUrl: "https://receiver.example/hook",
  secretKey: "super-secret",
  eventTypes: ["STREAM_CREATED"],
  isActive: true,
};
const PAYLOAD = {
  eventType: "STREAM_CREATED",
  data: { streamId: "1" },
  timestamp: "2026-10-21T12:00:00.000Z",
};
const NOW = Date.parse(PAYLOAD.timestamp);

interface Delivery {
  id: string;
  eventType: string;
  attempts: number;
  deliveredAt: Date | null;
  error: string | null;
}

function failedDeliveries(count: number, overrides: Partial<Delivery> = {}): Delivery[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `old_${index}`,
    eventType: PAYLOAD.eventType,
    attempts: 5,
    deliveredAt: null,
    error: "HTTP 503",
    ...overrides,
  }));
}

describe("webhook delivery", () => {
  const fetchMock = vi.fn();
  let history: Delivery[];

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal("fetch", fetchMock);
    history = [];

    prismaMock.webhookDelivery.create.mockImplementation(async ({ data }) => {
      const delivery = { id: "current", eventType: data.eventType, attempts: 0, deliveredAt: null, error: null };
      history.unshift(delivery);
      return delivery;
    });
    prismaMock.webhookDelivery.update.mockImplementation(async ({ where, data }) => {
      const delivery = history.find((row) => row.id === where.id)!;
      Object.assign(delivery, data);
      return delivery;
    });
    // Simulate Prisma filtering before LIMIT. Fixtures are newest first.
    prismaMock.webhookDelivery.findMany.mockImplementation(async ({ where, take }) =>
      history.filter((row) =>
        (!where.eventType || row.eventType !== where.eventType.not) &&
        (!where.OR || where.OR.some((condition: {
          deliveredAt?: { not: null };
          attempts?: { gte: number };
          error?: { not: null };
        }) =>
          (!condition.deliveredAt || row.deliveredAt !== null) &&
          (!condition.attempts || row.attempts >= condition.attempts.gte) &&
          (!condition.error || row.error !== null),
        )),
      ).slice(0, take),
    );
    fetchMock.mockResolvedValue({ status: 503 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function failProductionDelivery() {
    const result = deliverWebhook(SUBSCRIPTION, PAYLOAD);
    await vi.runAllTimersAsync();
    return result;
  }

  it("signs every attempt within the default replay window and keeps one delivery ID (#1694)", async () => {
    const attempts: Array<{ timestamp: number; signature: string; id: string; body: string; valid: boolean }> = [];
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const [, timestampText, signature] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(headers["X-FlowFi-Signature"]!)!;
      const timestamp = Number(timestampText);
      const body = String(init.body);
      attempts.push({
        timestamp,
        signature: signature!,
        id: headers["X-FlowFi-Delivery-ID"]!,
        body,
        valid: verifyWebhookSignature(body, signature!, SUBSCRIPTION.secretKey, timestamp),
      });
      return { status: 503 };
    });

    const result = await failProductionDelivery();

    expect(result).toEqual({ success: false, status: 503, error: "HTTP 503" });
    expect(attempts.map((attempt) => attempt.timestamp - NOW / 1000)).toEqual([0, 60, 360, 1260, 4860]);
    expect(attempts.map((attempt) => attempt.valid)).toEqual([true, true, true, true, true]);
    expect(new Set(attempts.map((attempt) => attempt.signature)).size).toBe(5);
    expect(new Set(attempts.map((attempt) => attempt.id)).size).toBe(1);
    expect(attempts[0]!.id).toBeTruthy();
    expect(attempts.every((attempt) => attempt.body === JSON.stringify(PAYLOAD))).toBe(true);
    expect(prismaMock.webhookDelivery.create).toHaveBeenCalledTimes(1);
  });

  it("does not disable a subscription because of 50 failed test pings (#1695)", async () => {
    history = failedDeliveries(50, { eventType: "webhook.test", attempts: 1 });

    await failProductionDelivery();

    expect(prismaMock.webhookSubscription.update).not.toHaveBeenCalled();
  });

  it("does not disable a subscription because of pending or retrying deliveries (#1695)", async () => {
    history = [
      ...failedDeliveries(25, { attempts: 0, error: null }),
      ...failedDeliveries(25, { attempts: 4 }),
    ];

    await failProductionDelivery();

    expect(prismaMock.webhookSubscription.update).not.toHaveBeenCalled();
  });

  it.each(["HTTP", "network"])("disables a subscription after 50 terminal %s production failures (#1695)", async (failure) => {
    history = failedDeliveries(49);
    if (failure === "network") fetchMock.mockRejectedValue(new Error("Network error"));

    await failProductionDelivery();

    expect(prismaMock.webhookSubscription.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: SUBSCRIPTION.id },
      data: { isActive: false },
    });
  });

  it("ignores test pings and in-flight rows before limiting the failure history (#1695)", async () => {
    history = [
      ...failedDeliveries(25, { eventType: "webhook.test", attempts: 1, deliveredAt: new Date(NOW), error: null }),
      ...failedDeliveries(25, { attempts: 4 }),
      ...failedDeliveries(49),
    ];

    await failProductionDelivery();

    expect(prismaMock.webhookSubscription.update).toHaveBeenCalledTimes(1);
  });

  it("resets the failure streak at a successful production delivery (#1695)", async () => {
    history = [
      ...failedDeliveries(48),
      ...failedDeliveries(1, { deliveredAt: new Date(NOW), attempts: 1, error: null }),
      ...failedDeliveries(50),
    ];

    await failProductionDelivery();

    expect(prismaMock.webhookSubscription.update).not.toHaveBeenCalled();
  });
});
