import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api/webhooks", () => ({
  listWebhookDeliveries: vi.fn(),
  sendWebhookTest: vi.fn(),
}));

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import toast from "react-hot-toast";
import {
  listWebhookDeliveries,
  type WebhookDelivery,
  type WebhookSubscription,
} from "@/lib/api/webhooks";
import { WebhookDeliveryModal } from "./WebhookDeliveryModal";

type DeliveriesPage = Awaited<ReturnType<typeof listWebhookDeliveries>>;

const subscription: WebhookSubscription = {
  id: "sub-1",
  userAddress: "GUSER",
  targetUrl: "https://example.com/hook",
  eventTypes: ["STREAM_CREATED"],
  isActive: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function delivery(id: string, eventType: string): WebhookDelivery {
  return {
    id,
    subscriptionId: subscription.id,
    eventType,
    payload: "{}",
    responseStatus: 200,
    attempts: 1,
    deliveredAt: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function pageOf(page: number, eventType: string, total: number): DeliveriesPage {
  return { deliveries: [delivery(`d-${page}`, eventType)], total, page, limit: 20 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("WebhookDeliveryModal delivery-log requests", () => {
  beforeEach(() => {
    vi.mocked(listWebhookDeliveries).mockReset();
    vi.mocked(toast.error).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores a slow older page that resolves after a newer one", async () => {
    const pages = new Map<number, ReturnType<typeof deferred<DeliveriesPage>>>();
    vi.mocked(listWebhookDeliveries).mockImplementation((_id, _user, page = 1) => {
      const request = deferred<DeliveriesPage>();
      pages.set(page, request);
      return request.promise;
    });

    render(
      <WebhookDeliveryModal subscription={subscription} userAddress="GUSER" onClose={vi.fn()} />,
    );

    await act(async () => pages.get(1)!.resolve(pageOf(1, "PAGE_ONE", 60)));
    expect(screen.getByText("PAGE_ONE")).toBeInTheDocument();

    // Page quickly through 2 to 3 while page 2 is still in flight.
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(listWebhookDeliveries).toHaveBeenLastCalledWith(subscription.id, "GUSER", 3);

    await act(async () => pages.get(3)!.resolve(pageOf(3, "PAGE_THREE", 60)));
    expect(screen.getByText("PAGE_THREE")).toBeInTheDocument();

    // The stale page-2 response arrives last and must not win.
    await act(async () => pages.get(2)!.resolve(pageOf(2, "PAGE_TWO", 999)));
    expect(screen.getByText("PAGE_THREE")).toBeInTheDocument();
    expect(screen.queryByText("PAGE_TWO")).not.toBeInTheDocument();
    expect(screen.getByText("60 deliveries")).toBeInTheDocument();
  });

  it("does not toast a stale page's failure after a newer page loads", async () => {
    const pages = new Map<number, ReturnType<typeof deferred<DeliveriesPage>>>();
    vi.mocked(listWebhookDeliveries).mockImplementation((_id, _user, page = 1) => {
      const request = deferred<DeliveriesPage>();
      pages.set(page, request);
      return request.promise;
    });

    render(
      <WebhookDeliveryModal subscription={subscription} userAddress="GUSER" onClose={vi.fn()} />,
    );
    await act(async () => pages.get(1)!.resolve(pageOf(1, "PAGE_ONE", 60)));

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await act(async () => pages.get(3)!.resolve(pageOf(3, "PAGE_THREE", 60)));
    await act(async () => pages.get(2)!.reject(new Error("page 2 failed")));

    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByText("PAGE_THREE")).toBeInTheDocument();
  });

  it("aborts the in-flight request on unmount and stays silent afterwards", async () => {
    const request = deferred<DeliveriesPage>();
    vi.mocked(listWebhookDeliveries).mockReturnValue(request.promise);
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { unmount } = render(
      <WebhookDeliveryModal subscription={subscription} userAddress="GUSER" onClose={vi.fn()} />,
    );
    unmount();
    expect(abortSpy).toHaveBeenCalled();

    await act(async () => request.reject(new Error("network down")));

    expect(toast.error).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("still reports a failure for the current request", async () => {
    vi.mocked(listWebhookDeliveries).mockRejectedValue(new Error("network down"));

    render(
      <WebhookDeliveryModal subscription={subscription} userAddress="GUSER" onClose={vi.fn()} />,
    );

    await act(async () => {});
    expect(toast.error).toHaveBeenCalledWith("network down");
  });
});
