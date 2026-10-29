import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SSEStatusIndicator } from "./SSEStatusIndicator";

describe("SSEStatusIndicator", () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows Connected status text and last sync time when connected", () => {
    const lastEventAt = NOW - 30_000; // 30s ago
    render(
      <SSEStatusIndicator
        connected
        reconnecting={false}
        error={null}
        lastEventAt={lastEventAt}
      />
    );

    const statusEl = screen.getByRole("status");
    expect(statusEl).toBeInTheDocument();
    expect(statusEl).toHaveAttribute("aria-label", "Connected — Last sync: 30s ago");
    expect(statusEl).toHaveAttribute("title", "Connected — Last sync: 30s ago");
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("shows Reconnecting status and last sync time when reconnecting", () => {
    const lastEventAt = NOW - 120_000; // 2m ago
    render(
      <SSEStatusIndicator
        connected={false}
        reconnecting
        error={null}
        lastEventAt={lastEventAt}
      />
    );

    const statusEl = screen.getByRole("status");
    expect(statusEl).toHaveAttribute("aria-label", "Reconnecting — Last sync: 2m ago");
    expect(screen.getByText("Reconnecting...")).toBeInTheDocument();
  });

  it("shows Offline status and fallback text when disconnected with no lastEventAt", () => {
    render(
      <SSEStatusIndicator
        connected={false}
        reconnecting={false}
        error={null}
        lastEventAt={null}
      />
    );

    const statusEl = screen.getByRole("status");
    expect(statusEl).toHaveAttribute(
      "aria-label",
      "Offline — No events received yet"
    );
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });

  it("shows Offline when an error is present", () => {
    render(
      <SSEStatusIndicator
        connected={false}
        reconnecting={false}
        error={new Error("connection refused")}
        lastEventAt={NOW - 1_000}
      />
    );

    const statusEl = screen.getByRole("status");
    expect(statusEl).toHaveAttribute(
      "aria-label",
      "Offline — Last sync: just now"
    );
  });
});
