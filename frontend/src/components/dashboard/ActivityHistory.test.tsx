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
