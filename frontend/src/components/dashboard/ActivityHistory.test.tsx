import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BackendStreamEvent } from "@/lib/api-types";

vi.mock("@/utils/csvExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/csvExport")>();
  return {
    ...actual,
    downloadCSV: vi.fn(),
  };
});

import { ActivityHistory } from "./ActivityHistory";
import { convertArrayToCSV, downloadCSV } from "@/utils/csvExport";

const makeEvent = (
  overrides: Partial<BackendStreamEvent> = {}
): BackendStreamEvent => ({
  id: "evt-1",
  streamId: 12345,
  eventType: "CREATED",
  amount: "10000000000",
  transactionHash: "",
  ledgerSequence: 1000,
  timestamp: 1700000000,
  metadata: null,
  createdAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("ActivityHistory CSV export", () => {
  beforeEach(() => {
    vi.mocked(downloadCSV).mockClear();
  });

  it("exports via the shared downloadCSV utility with a timestamped filename", () => {
    render(<ActivityHistory events={[makeEvent()]} />);

    fireEvent.click(screen.getByRole("button", { name: /export csv/i }));

    expect(downloadCSV).toHaveBeenCalledTimes(1);
    const [data, filename] = vi.mocked(downloadCSV).mock.calls[0]!;
    expect(filename).toMatch(/^flowfi_activity_\d+\.csv$/);
    expect(data).toEqual([
      {
        "Stream ID": 12345,
        "Event Type": "CREATED",
        "Amount": "1000",
        "Timestamp": "2023-11-14T22:13:20.000Z",
        "Tx Hash": "",
      },
    ]);
  });

  it("produces a correctly escaped, spreadsheet-safe CSV for fields containing commas and quotes", () => {
    const events = [
      makeEvent({
        id: "evt-1",
        streamId: 1,
        eventType: "CREATED",
        transactionHash: "",
      }),
      makeEvent({
        id: "evt-2",
        streamId: 2,
        eventType: "TOPPED_UP",
        transactionHash: 'abc,def"ghi',
      }),
    ];

    render(<ActivityHistory events={events} />);

    fireEvent.click(screen.getByRole("button", { name: /export csv/i }));

    const [data] = vi.mocked(downloadCSV).mock.calls[0]!;
    const csv = convertArrayToCSV(data);

    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "Stream ID,Event Type,Amount,Timestamp,Tx Hash"
    );
    // Second row's Tx Hash contains a comma and double-quote and must be quoted + escaped.
    expect(lines[2]).toContain('"abc,def""ghi"');
    expect(csv).not.toContain(
      'abc,def"ghi"'
    );
  });

  it("disables the export button when there are no events", () => {
    render(<ActivityHistory events={[]} />);

    expect(
      screen.getByRole("button", { name: /export csv/i })
    ).toBeDisabled();
    expect(downloadCSV).not.toHaveBeenCalled();
  });
});

describe("ActivityHistory malformed metadata", () => {
  it("renders a fallback for FEE_CONFIG_UPDATED with malformed metadata instead of throwing", () => {
    const event = makeEvent({
      eventType: "FEE_CONFIG_UPDATED",
      metadata: "{not valid json",
    });

    expect(() => render(<ActivityHistory events={[event]} />)).not.toThrow();
    expect(screen.getByText("Fee configuration updated")).toBeInTheDocument();
  });

  it("renders a fallback for ADMIN_TRANSFERRED with malformed metadata instead of throwing", () => {
    const event = makeEvent({
      eventType: "ADMIN_TRANSFERRED",
      metadata: "}{ truncated",
    });

    expect(() => render(<ActivityHistory events={[event]} />)).not.toThrow();
    expect(screen.getByText("Admin transferred")).toBeInTheDocument();
  });

  it("still renders parsed detail for well-formed FEE_CONFIG_UPDATED metadata", () => {
    const event = makeEvent({
      eventType: "FEE_CONFIG_UPDATED",
      metadata: JSON.stringify({ old_fee_rate_bps: 100, new_fee_rate_bps: 250 }),
    });

    render(<ActivityHistory events={[event]} />);
    expect(
      screen.getByText("Fee configuration updated: 1% → 2.5%")
    ).toBeInTheDocument();
  });

  it("still renders parsed detail for well-formed ADMIN_TRANSFERRED metadata", () => {
    const event = makeEvent({
      eventType: "ADMIN_TRANSFERRED",
      metadata: JSON.stringify({ new_admin: "GABCDEF123" }),
    });

    render(<ActivityHistory events={[event]} />);
    expect(
      screen.getByText("Admin transferred to GABCDEF123")
    ).toBeInTheDocument();
  });

  it("renders fallback for empty metadata string", () => {
    const event = makeEvent({
      eventType: "FEE_CONFIG_UPDATED",
      metadata: "",
    });

    expect(() => render(<ActivityHistory events={[event]} />)).not.toThrow();
    expect(screen.getByText("Fee configuration updated")).toBeInTheDocument();
  });

  it("renders fallback for undefined metadata", () => {
    const event = makeEvent({
      eventType: "ADMIN_TRANSFERRED",
      metadata: undefined,
    });

    expect(() => render(<ActivityHistory events={[event]} />)).not.toThrow();
    expect(screen.getByText("Admin transferred")).toBeInTheDocument();
  });

  it("renders fallback for null metadata", () => {
    const event = makeEvent({
      eventType: "FEE_CONFIG_UPDATED",
      metadata: null,
    });

    expect(() => render(<ActivityHistory events={[event]} />)).not.toThrow();
    expect(screen.getByText("Fee configuration updated")).toBeInTheDocument();
  });

  it("renders fallback for metadata that is not an object", () => {
    const event = makeEvent({
      eventType: "FEE_CONFIG_UPDATED",
      metadata: "just a string",
    });

    expect(() => render(<ActivityHistory events={[event]} />)).not.toThrow();
    expect(screen.getByText("Fee configuration updated")).toBeInTheDocument();
  });

  it("renders fallback for array metadata", () => {
    const event = makeEvent({
      eventType: "ADMIN_TRANSFERRED",
      metadata: JSON.stringify([1, 2, 3]),
    });

    expect(() => render(<ActivityHistory events={[event]} />)).not.toThrow();
    expect(screen.getByText("Admin transferred")).toBeInTheDocument();
  });

  it("renders fallback for metadata with nested invalid JSON", () => {
    const event = makeEvent({
      eventType: "FEE_CONFIG_UPDATED",
      metadata: JSON.stringify({ nested: "{invalid" }),
    });

    expect(() => render(<ActivityHistory events={[event]} />)).not.toThrow();
    expect(screen.getByText("Fee configuration updated")).toBeInTheDocument();
  });

  it("renders fallback for deeply nested malformed metadata", () => {
    const event = makeEvent({
      eventType: "ADMIN_TRANSFERRED",
      metadata: JSON.stringify({ admin: { extra: "data" } }),
    });

    expect(() => render(<ActivityHistory events={[event]} />)).not.toThrow();
    expect(screen.getByText("Admin transferred")).toBeInTheDocument();
  });

  it("handles metadata with trailing comma", () => {
    const event = makeEvent({
      eventType: "FEE_CONFIG_UPDATED",
      metadata: "{old_fee_rate_bps: 100,}",
    });

    expect(() => render(<ActivityHistory events={[event]} />)).not.toThrow();
    expect(screen.getByText("Fee configuration updated")).toBeInTheDocument();
  });

  it("handles metadata with single quotes", () => {
    const event = makeEvent({
      eventType: "FEE_CONFIG_UPDATED",
      metadata: "{'old_fee_rate_bps': 100}",
    });

    expect(() => render(<ActivityHistory events={[event]} />)).not.toThrow();
    expect(screen.getByText("Fee configuration updated")).toBeInTheDocument();
  });

  it("handles metadata with special characters", () => {
    const event = makeEvent({
      eventType: "FEE_CONFIG_UPDATED",
      metadata: JSON.stringify({ old_fee_rate_bps: 100, new_fee_rate_bps: 0 }),
    });

    render(<ActivityHistory events={[event]} />);
    expect(
      screen.getByText("Fee configuration updated: 1% → 0%")
    ).toBeInTheDocument();
  });

  it("handles metadata with very large fee rates", () => {
    const event = makeEvent({
      eventType: "FEE_CONFIG_UPDATED",
      metadata: JSON.stringify({ old_fee_rate_bps: 10000, new_fee_rate_bps: 20000 }),
    });

    render(<ActivityHistory events={[event]} />);
    expect(
      screen.getByText("Fee configuration updated: 100% → 200%")
    ).toBeInTheDocument();
  });

  it("handles metadata with zero fee rates", () => {
    const event = makeEvent({
      eventType: "FEE_CONFIG_UPDATED",
      metadata: JSON.stringify({ old_fee_rate_bps: 0, new_fee_rate_bps: 50 }),
    });

    render(<ActivityHistory events={[event]} />);
    expect(
      screen.getByText("Fee configuration updated: 0% → 0.5%")
    ).toBeInTheDocument();
  });
});

describe("ActivityHistory event rendering", () => {
  const makeEventWith = (overrides: Partial<BackendStreamEvent> = {}) => makeEvent(overrides);

  it("renders CREATED event", () => {
    const event = makeEventWith({ eventType: "CREATED" });
    render(<ActivityHistory events={[event]} />);
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent?.startsWith("New stream created (") === true,
      ),
    ).toBeInTheDocument();
  });

  it("renders TOPPED_UP event with amount", () => {
    const event = makeEventWith({ eventType: "TOPPED_UP", amount: "5000" });
    render(<ActivityHistory events={[event]} />);
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent?.startsWith("Topped up Stream #12345 with") === true,
      ),
    ).toBeInTheDocument();
  });

  it("renders WITHDRAWN event", () => {
    const event = makeEventWith({ eventType: "WITHDRAWN" });
    render(<ActivityHistory events={[event]} />);
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "P" &&
          element.textContent?.startsWith(
            "Withdrew 1000 tokens from Stream #12345",
          ) === true,
      ),
    ).toBeInTheDocument();
  });

  it("renders CANCELLED event", () => {
    const event = makeEventWith({ eventType: "CANCELLED" });
    render(<ActivityHistory events={[event]} />);
    expect(screen.getByText("Stream was cancelled")).toBeInTheDocument();
  });

  it("renders COMPLETED event", () => {
    const event = makeEventWith({ eventType: "COMPLETED" });
    render(<ActivityHistory events={[event]} />);
    expect(screen.getByText("Stream was completed")).toBeInTheDocument();
  });

  it("renders PAUSED event", () => {
    const event = makeEventWith({ eventType: "PAUSED" });
    render(<ActivityHistory events={[event]} />);
    expect(screen.getByText("Stream was paused")).toBeInTheDocument();
  });

  it("renders RESUMED event", () => {
    const event = makeEventWith({ eventType: "RESUMED" });
    render(<ActivityHistory events={[event]} />);
    expect(screen.getByText("Stream was resumed")).toBeInTheDocument();
  });

  it("renders FEE_COLLECTED event", () => {
    const event = makeEventWith({
      eventType: "FEE_COLLECTED",
      amount: "1000000000",
    });
    render(<ActivityHistory events={[event]} />);
    expect(
      screen.getByText(
        (_, element) =>
          element?.textContent === "Fee of 100 collected on Stream #12345",
      ),
    ).toBeInTheDocument();
  });

});