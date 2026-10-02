import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  sendWebhookTest,
  regenerateWebhookSecret,
} from "./webhooks";
import * as shared from "./_shared";

vi.mock("./_shared", () => ({
  fetchWithTimeout: vi.fn(),
  getApiBaseUrl: () => "http://test-api",
}));

describe("webhooks api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shared.fetchWithTimeout).mockResolvedValue({
      ok: true,
      json: async () => ({ subscriptions: [], secretKey: "secret", result: { success: true }, deliveries: [], total: 0, page: 1, limit: 20 }),
      status: 200,
    } as unknown as Response);
  });

  it("calls listWebhooks", async () => {
    const res = await listWebhooks("address");
    expect(res).toEqual([]);
    expect(shared.fetchWithTimeout).toHaveBeenCalledWith(
      "http://test-api/v1/webhooks?userAddress=address",
      expect.any(Object)
    );
  });

  it("calls createWebhook", async () => {
    await createWebhook({ userAddress: "a", targetUrl: "u", eventTypes: [] });
    expect(shared.fetchWithTimeout).toHaveBeenCalled();
  });

  it("calls updateWebhook", async () => {
    await updateWebhook("id", "address", { targetUrl: "new" });
    expect(shared.fetchWithTimeout).toHaveBeenCalled();
  });

  it("calls deleteWebhook", async () => {
    vi.mocked(shared.fetchWithTimeout).mockResolvedValueOnce({
      ok: true,
      status: 204,
    } as unknown as Response);
    await deleteWebhook("id", "address");
    expect(shared.fetchWithTimeout).toHaveBeenCalled();
  });

  it("calls listWebhookDeliveries", async () => {
    await listWebhookDeliveries("id", "address");
    expect(shared.fetchWithTimeout).toHaveBeenCalled();
  });

  it("calls sendWebhookTest", async () => {
    await sendWebhookTest("id", "address");
    expect(shared.fetchWithTimeout).toHaveBeenCalled();
  });

  it("calls regenerateWebhookSecret", async () => {
    await regenerateWebhookSecret("id", "address");
    expect(shared.fetchWithTimeout).toHaveBeenCalled();
  });

  it("throws error when response is not ok", async () => {
    vi.mocked(shared.fetchWithTimeout).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "Bad Request" }),
    } as unknown as Response);
    await expect(listWebhooks("address")).rejects.toThrow("Bad Request");
  });
});
