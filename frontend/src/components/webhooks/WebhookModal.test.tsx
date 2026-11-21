import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WebhookModal } from "./WebhookModal";

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("react-hot-toast", () => ({
  default: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}));

const USER = "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7";

describe("WebhookModal submission", () => {
  beforeEach(() => {
    toastError.mockClear();
    toastSuccess.mockClear();
  });

  it("submits the typed endpoint and the selected event types", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<WebhookModal userAddress={USER} onClose={vi.fn()} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText(/https endpoint/i), {
      target: { value: "https://api.example.com/hook" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save webhook/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0]![0];
    expect(payload.targetUrl).toBe("https://api.example.com/hook");
    expect(payload.eventTypes.length).toBeGreaterThan(0);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows an error toast and stays open when the save is rejected", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("network down"));
    const onClose = vi.fn();
    render(<WebhookModal userAddress={USER} onClose={onClose} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText(/https endpoint/i), {
      target: { value: "https://api.example.com/hook" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save webhook/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Failed to save webhook"));
    expect(onClose).not.toHaveBeenCalled();
    // The button is usable again rather than stuck on "Saving...".
    expect(screen.getByRole("button", { name: /save webhook/i })).toBeEnabled();
  });

  it("refuses to submit a non-HTTPS endpoint", async () => {
    const onSave = vi.fn();
    render(<WebhookModal userAddress={USER} onClose={vi.fn()} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText(/https endpoint/i), {
      target: { value: "http://insecure.example.com/hook" },
    });

    expect(screen.getByText(/enter a valid https url/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save webhook/i })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
