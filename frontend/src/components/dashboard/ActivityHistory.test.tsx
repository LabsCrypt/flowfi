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
});

describe("ActivityHistory event type filter pills", () => {
  const sampleEvents = [
    makeEvent({ id: "evt-created", streamId: 10, eventType: "CREATED" }),
    makeEvent({
      id: "evt-withdrawn",
      streamId: 11,
      eventType: "WITHDRAWN",
      amount: "250000000",
    }),
    makeEvent({
      id: "evt-topped",
      streamId: 12,
      eventType: "TOPPED_UP",
      amount: "500000000",
    }),
    makeEvent({ id: "evt-paused", streamId: 13, eventType: "PAUSED" }),
  ];

  it("selects 'All' by default and displays all activity items", () => {
    render(<ActivityHistory events={sampleEvents} />);

    const allButton = screen.getByRole("button", { name: /^All$/i });
    expect(allButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("filters displayed items immediately when clicking Created, Withdrawn, Topped Up, or Paused", () => {
    render(<ActivityHistory events={sampleEvents} />);

    fireEvent.click(screen.getByRole("button", { name: /^Withdrawn$/i }));
    expect(screen.getByRole("button", { name: /^Withdrawn$/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: /^All$/i })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText(/Withdrew 25 tokens from Stream/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Topped Up$/i }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText(/Topped up Stream/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Paused$/i }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText(/was paused/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Created$/i }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText(/New stream created/i)).toBeInTheDocument();
  });

  it("shows empty state message when no events match the selected filter", () => {
    render(<ActivityHistory events={sampleEvents} />);

    fireEvent.click(screen.getByRole("button", { name: /^Cancelled$/i }));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(
      screen.getByText("No activity found for this filter."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^All$/i }));
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });
});
