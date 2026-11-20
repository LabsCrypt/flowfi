import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import toast from "react-hot-toast";
import WebhooksPage from "./page";
import * as api from "@/lib/api/webhooks";

vi.mock("react-hot-toast", () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/context/wallet-context", () => ({ useWallet: () => ({ session: { publicKey: "GA" } }) }));
vi.mock("@/lib/api/webhooks", () => ({
  listWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  updateWebhook: vi.fn(),
  regenerateWebhookSecret: vi.fn(),
}));
vi.mock("@/components/webhooks/WebhookModal", () => ({ WebhookModal: () => null }));
vi.mock("@/components/webhooks/WebhookDeliveryModal", () => ({ WebhookDeliveryModal: () => null }));

const sub = { id: "wh_1", userAddress: "GA", targetUrl: "https://a.example/hook", eventTypes: ["STREAM_CREATED"], isActive: true, createdAt: "2026-09-20T00:00:00.000Z" };

describe("WebhooksPage error handling", () => {
  const unhandled = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listWebhooks).mockResolvedValue([sub]);
    process.on("unhandledRejection", unhandled);
  });
  afterEach(() => {
    process.off("unhandledRejection", unhandled);
    cleanup();
  });

  it("shows an error toast when toggling fails", async () => {
    vi.mocked(api.updateWebhook).mockRejectedValue(new Error("toggle boom"));
    render(<WebhooksPage />);
    fireEvent.click(await screen.findByLabelText("Toggle webhook"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("toggle boom"));
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("uses the shared confirm modal and toasts when delete fails", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    vi.mocked(api.deleteWebhook).mockRejectedValue(new Error("delete boom"));
    render(<WebhooksPage />);
    fireEvent.click(await screen.findByLabelText("Delete webhook"));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(await screen.findByText("Delete this webhook endpoint? This cannot be undone.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("delete boom"));
    expect(unhandled).not.toHaveBeenCalled();
  });
});
