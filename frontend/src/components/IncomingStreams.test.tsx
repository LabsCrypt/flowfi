import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/hooks/useStreamingAmount", () => ({
  useStreamingAmount: () => 0,
}));

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

vi.mock("@/lib/transaction-feedback", () => ({
  transactionSuccessToast: vi.fn(),
}));

import IncomingStreams from "./IncomingStreams";
import type { Stream } from "@/lib/dashboard";

const STORAGE_KEY = "flowfi.table.incoming-streams.v1";

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "1",
    recipient: "Alice",
    amount: 100,
    token: "USDC",
    status: "Active",
    deposited: 100,
    withdrawn: 10,
    date: "2026-01-01",
    ratePerSecond: 0,
    lastUpdateTime: 0,
    isActive: true,
    ...overrides,
  };
}

function renderTable(streams: Stream[] = [makeStream()]) {
  return render(<IncomingStreams streams={streams} onWithdraw={vi.fn()} />);
}

function sortButton(label: string) {
  return screen.getByRole("button", { name: `Sort by ${label}` });
}

function querySortButton(label: string) {
  return screen.queryByRole("button", { name: `Sort by ${label}` });
}

function visibleColumnLabels(): string[] {
  return screen
    .getAllByRole("columnheader")
    .map((header) => header.textContent?.trim() ?? "")
    .filter((label) => label !== "Actions");
}

function rowRecipients(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelector(".font-mono")?.textContent?.trim() ?? "");
}

describe("IncomingStreams table preferences", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders all columns and the settings control by default", () => {
    renderTable();

    for (const label of ["Sender", "Token", "Deposited", "Withdrawn", "Claimable", "Status"]) {
      expect(sortButton(label)).toBeInTheDocument();
    }
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
    expect(screen.getByLabelText("Table settings")).toBeInTheDocument();
  });

  it("hides a column from the settings dropdown and persists the choice", async () => {
    renderTable();

    fireEvent.click(screen.getByLabelText("Table settings"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Token" }));

    await waitFor(() => {
      expect(querySortButton("Token")).not.toBeInTheDocument();
    });

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      expect(stored.visibleColumns).not.toContain("token");
    });

    expect(sortButton("Sender")).toBeInTheDocument();
  });

  it("restores hidden columns from localStorage on mount", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sortBy: null,
        sortDirection: "desc",
        visibleColumns: ["sender", "deposited", "withdrawn", "claimable", "status"],
      }),
    );

    renderTable();

    await waitFor(() => {
      expect(querySortButton("Token")).not.toBeInTheDocument();
    });
    expect(sortButton("Sender")).toBeInTheDocument();
    expect(visibleColumnLabels()).toEqual([
      "Sender",
      "Deposited",
      "Withdrawn",
      "Claimable",
      "Status",
    ]);
  });

  it("resets the table layout from the settings dropdown", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sortBy: "deposited",
        sortDirection: "asc",
        visibleColumns: ["sender"],
      }),
    );

    renderTable();

    await waitFor(() => {
      expect(querySortButton("Token")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("Table settings"));
    fireEvent.click(screen.getByText("Reset Table Layout"));

    await waitFor(() => {
      expect(sortButton("Token")).toBeInTheDocument();
    });
    expect(visibleColumnLabels()).toEqual([
      "Sender",
      "Token",
      "Deposited",
      "Withdrawn",
      "Claimable",
      "Status",
    ]);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(stored.visibleColumns).toEqual([
      "sender",
      "token",
      "deposited",
      "withdrawn",
      "claimable",
      "status",
    ]);
    expect(stored.sortBy).toBeNull();
  });

  it("sorts rows when a column header is clicked", () => {
    renderTable([
      makeStream({ id: "1", recipient: "Alice", deposited: 100 }),
      makeStream({ id: "2", recipient: "Bob", deposited: 300 }),
      makeStream({ id: "3", recipient: "Carol", deposited: 50 }),
    ]);

    fireEvent.click(sortButton("Deposited")); // ascending
    expect(rowRecipients()).toEqual(["Carol", "Alice", "Bob"]);

    fireEvent.click(sortButton("Deposited")); // descending
    expect(rowRecipients()).toEqual(["Bob", "Alice", "Carol"]);
  });

  it("restores the persisted sort order on mount", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sortBy: "deposited",
        sortDirection: "desc",
        visibleColumns: ["sender", "token", "deposited", "withdrawn", "claimable", "status"],
      }),
    );

    renderTable([
      makeStream({ id: "1", recipient: "Alice", deposited: 100 }),
      makeStream({ id: "2", recipient: "Bob", deposited: 300 }),
      makeStream({ id: "3", recipient: "Carol", deposited: 50 }),
    ]);

    await waitFor(() => {
      expect(rowRecipients()).toEqual(["Bob", "Alice", "Carol"]);
    });
  });

  it("renders safely when localStorage contains corrupted data", async () => {
    localStorage.setItem(STORAGE_KEY, "{not json");

    renderTable();

    await waitFor(() => {
      expect(sortButton("Token")).toBeInTheDocument();
    });
  });
});
