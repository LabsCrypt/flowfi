import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useTablePreferences } from "./useTablePreferences";

const STORAGE_KEY = "flowfi.test.table.v1";
const DEFAULT_COLUMNS = ["sender", "amount", "status"] as const;
const DEFAULT_VISIBLE = ["sender", "amount", "status"];

function renderPreferences(
  options: Partial<Parameters<typeof useTablePreferences>[0]> = {},
) {
  return renderHook(() =>
    useTablePreferences({
      storageKey: STORAGE_KEY,
      defaultColumns: DEFAULT_COLUMNS,
      ...options,
    }),
  );
}

describe("useTablePreferences", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts with all columns visible and no sort", () => {
    const { result } = renderPreferences();

    expect(result.current.sortBy).toBeNull();
    expect(result.current.sortDirection).toBe("desc");
    expect(result.current.visibleColumns).toEqual(DEFAULT_VISIBLE);
    expect(result.current.isVisible("sender")).toBe(true);
    expect(result.current.isVisible("status")).toBe(true);
  });

  it("hydrates persisted preferences from localStorage", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sortBy: "amount",
        sortDirection: "desc",
        visibleColumns: ["sender", "amount"],
      }),
    );

    const { result } = renderPreferences();

    expect(result.current.sortBy).toBe("amount");
    expect(result.current.sortDirection).toBe("desc");
    expect(result.current.visibleColumns).toEqual(["sender", "amount"]);
    expect(result.current.isVisible("status")).toBe(false);
  });

  it("persists sort changes and toggles direction", async () => {
    const { result } = renderPreferences();

    act(() => result.current.setSort("amount"));
    expect(result.current.sortBy).toBe("amount");
    expect(result.current.sortDirection).toBe("asc");

    act(() => result.current.setSort("amount"));
    expect(result.current.sortDirection).toBe("desc");

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      expect(stored).toMatchObject({ sortBy: "amount", sortDirection: "desc" });
    });
  });

  it("persists and restores hidden columns across remounts", async () => {
    const first = renderPreferences();

    act(() => first.result.current.toggleColumn("status"));
    expect(first.result.current.isVisible("status")).toBe(false);

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      expect(stored.visibleColumns).toEqual(["sender", "amount"]);
    });

    first.unmount();

    const second = renderPreferences();
    expect(second.result.current.isVisible("status")).toBe(false);
    expect(second.result.current.visibleColumns).toEqual(["sender", "amount"]);
  });

  it("restores the default layout on reset", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sortBy: "amount",
        sortDirection: "asc",
        visibleColumns: ["sender"],
      }),
    );

    const { result } = renderPreferences();
    expect(result.current.sortBy).toBe("amount");
    expect(result.current.visibleColumns).toEqual(["sender"]);

    act(() => result.current.resetPreferences());

    expect(result.current.sortBy).toBeNull();
    expect(result.current.sortDirection).toBe("desc");
    expect(result.current.visibleColumns).toEqual(DEFAULT_VISIBLE);

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      expect(stored.visibleColumns).toEqual(DEFAULT_VISIBLE);
    });
  });

  it("falls back to defaults when localStorage contains corrupted JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not valid json");

    const { result } = renderPreferences();

    expect(result.current.sortBy).toBeNull();
    expect(result.current.visibleColumns).toEqual(DEFAULT_VISIBLE);
  });

  it("drops stale/unknown columns and invalid sort from stored state", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sortBy: "ghost",
        sortDirection: "sideways",
        visibleColumns: ["sender", "ghost", "sender", 42],
      }),
    );

    const { result } = renderPreferences();

    expect(result.current.sortBy).toBeNull();
    expect(result.current.sortDirection).toBe("desc");
    expect(result.current.visibleColumns).toEqual(["sender"]);
  });

  it("never hides the last remaining column", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sortBy: null,
        sortDirection: "desc",
        visibleColumns: ["sender"],
      }),
    );

    const { result } = renderPreferences();
    expect(result.current.visibleColumns).toEqual(["sender"]);

    act(() => result.current.toggleColumn("sender"));

    expect(result.current.visibleColumns).toEqual(DEFAULT_VISIBLE);
  });
});
