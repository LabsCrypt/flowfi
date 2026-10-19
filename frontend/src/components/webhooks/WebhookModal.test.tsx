import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WebhookModal, validateWebhookUrl } from "./WebhookModal";

afterEach(() => {
  cleanup();
});

describe("validateWebhookUrl", () => {
  it("treats empty or whitespace-only input as invalid without showing an error message", () => {
    expect(validateWebhookUrl("")).toEqual({ valid: false, error: null });
    expect(validateWebhookUrl("   ")).toEqual({ valid: false, error: null });
  });

  it("accepts valid https:// URLs", () => {
    expect(validateWebhookUrl("https://api.example.com/flowfi")).toEqual({
      valid: true,
      error: null,
    });
    expect(validateWebhookUrl("  https://hooks.example.org:8443/v1/events?env=prod  ")).toEqual({
      valid: true,
      error: null,
    });
  });

  it("accepts loopback http:// URLs for local development", () => {
    expect(validateWebhookUrl("http://localhost:3001/webhooks")).toEqual({
      valid: true,
      error: null,
    });
    expect(validateWebhookUrl("http://127.0.0.1:4000/hook")).toEqual({
      valid: true,
      error: null,
    });
    expect(validateWebhookUrl("http://[::1]:8080/hook")).toEqual({
      valid: true,
      error: null,
    });
  });

  it("rejects non-loopback http:// URLs with a clear protocol error", () => {
    const result = validateWebhookUrl("http://api.example.com/flowfi");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/must use https:\/\//i);
  });

  it("rejects malformed URLs and unsupported schemes", () => {
    for (const invalid of [
      "https://",
      "http://",
      "not-a-url",
      "https://exa mple.com/hook",
      "ftp://files.example.com/hook",
    ]) {
      const result = validateWebhookUrl(invalid);
      expect(result.valid).toBe(false);
      expect(result.error).toBeTruthy();
    }
  });
});

describe("WebhookModal URL validation", () => {
  it("disables Save button initially and does not display an error on empty input", () => {
    render(
      <WebhookModal
        userAddress="GABC123"
        onClose={vi.fn()}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const saveButton = screen.getByRole("button", { name: /save webhook/i });
    expect(saveButton).toBeDisabled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an inline error and keeps Save disabled when a plain http:// URL is entered", () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <WebhookModal
        userAddress="GABC123"
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    const input = screen.getByLabelText(/https endpoint/i);
    fireEvent.change(input, { target: { value: "http://example.com/webhook" } });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/must use https:\/\//i);
    expect(input).toHaveAttribute("aria-invalid", "true");

    const saveButton = screen.getByRole("button", { name: /save webhook/i });
    expect(saveButton).toBeDisabled();
    fireEvent.click(saveButton);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows an inline error for incomplete or malformed https:// input", () => {
    render(
      <WebhookModal
        userAddress="GABC123"
        onClose={vi.fn()}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const input = screen.getByLabelText(/https endpoint/i);
    fireEvent.change(input, { target: { value: "https://" } });

    expect(screen.getByRole("alert")).toHaveTextContent(/valid https url/i);
    expect(screen.getByRole("button", { name: /save webhook/i })).toBeDisabled();
  });

  it("enables Save and submits trimmed URL for valid https:// and localhost http:// endpoints", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <WebhookModal
        userAddress="GABC123"
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );

    const input = screen.getByLabelText(/https endpoint/i);
    const saveButton = screen.getByRole("button", { name: /save webhook/i });

    fireEvent.change(input, { target: { value: "  https://api.example.com/flowfi  " } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(saveButton).not.toBeDisabled();

    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          targetUrl: "https://api.example.com/flowfi",
        }),
      );
    });

    fireEvent.change(input, { target: { value: "http://localhost:3000/hooks" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton).not.toBeDisabled();
  });
});
