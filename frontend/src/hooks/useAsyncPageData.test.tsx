import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAsyncPageData, type AsyncPageDataInput } from "./useAsyncPageData";

const base: AsyncPageDataInput = {
  enabled: true,
  isLoading: false,
  isError: false,
  isEmpty: false,
  error: null,
};

/** The precedence the hook is supposed to implement, written independently. */
function expectedState({
  isLoading,
  isError,
  isEmpty,
}: Pick<AsyncPageDataInput, "isLoading" | "isError" | "isEmpty">) {
  if (isError) return "error";
  if (isLoading) return "loading";
  if (isEmpty) return "empty";
  return "ready";
}

function renderView(overrides: Partial<AsyncPageDataInput> = {}) {
  return renderHook(() => useAsyncPageData({ ...base, ...overrides })).result
    .current;
}

describe("useAsyncPageData", () => {
  it("is awaiting while the page has no data source yet", () => {
    const view = renderView({ enabled: false, isLoading: true, isError: true });

    expect(view.state).toBe("awaiting");
    expect(view.isEnabled).toBe(false);
    expect(view.isError).toBe(false);
    expect(view.isLoading).toBe(false);
    expect(view.isReady).toBe(false);
  });

  it("resolves to ready once enabled with data present", () => {
    const view = renderView();

    expect(view.state).toBe("ready");
    expect(view.isReady).toBe(true);
  });

  it("reports loading before there is any data", () => {
    const view = renderView({ isLoading: true, isEmpty: true });

    expect(view.state).toBe("loading");
    expect(view.isLoading).toBe(true);
    expect(view.isEmpty).toBe(false);
  });

  it("reports empty when the load finished with nothing to show", () => {
    const view = renderView({ isEmpty: true });

    expect(view.state).toBe("empty");
    expect(view.isEmpty).toBe(true);
    expect(view.isReady).toBe(false);
  });

  it("surfaces the error message", () => {
    const view = renderView({ isError: true, error: "Failed to fetch activity. Please try again." });

    expect(view.state).toBe("error");
    expect(view.error).toBe("Failed to fetch activity. Please try again.");
  });

  it("defaults the message to null when no error is provided", () => {
    const { error } = renderHook(() =>
      useAsyncPageData({ enabled: true, isLoading: false, isError: false, isEmpty: false }),
    ).result.current;

    expect(error).toBeNull();
  });

  describe("precedence", () => {
    it("keeps an error visible while a background refetch is loading", () => {
      expect(renderView({ isError: true, isLoading: true, error: "boom" }).state).toBe("error");
    });

    it("prefers loading over empty while the first page is in flight", () => {
      expect(renderView({ isLoading: true, isEmpty: true }).state).toBe("loading");
    });

    it("prefers empty over ready", () => {
      expect(renderView({ isEmpty: true }).state).toBe("empty");
    });

    it("yields exactly one active state for every combination of inputs", () => {
      for (const enabled of [true, false]) {
        for (const isLoading of [true, false]) {
          for (const isError of [true, false]) {
            for (const isEmpty of [true, false]) {
              const view = renderView({ enabled, isLoading, isError, isEmpty });
              const label = JSON.stringify({ enabled, isLoading, isError, isEmpty });
              const active = [
                !view.isEnabled,
                view.isError,
                view.isLoading,
                view.isEmpty,
                view.isReady,
              ].filter(Boolean);

              expect(active, label).toHaveLength(1);
              expect(view.state, label).toBe(enabled ? expectedState({ isLoading, isError, isEmpty }) : "awaiting");
            }
          }
        }
      }
    });
  });

  it("recomputes the state when the inputs change", () => {
    const view = renderHook(
      ({ isLoading, isEmpty }: { isLoading: boolean; isEmpty: boolean }) =>
        useAsyncPageData({ ...base, isLoading, isEmpty }),
      { initialProps: { isLoading: true, isEmpty: true } },
    );

    expect(view.result.current.state).toBe("loading");
    view.rerender({ isLoading: false, isEmpty: true });
    expect(view.result.current.state).toBe("empty");
    view.rerender({ isLoading: false, isEmpty: false });
    expect(view.result.current.state).toBe("ready");
  });
});
