import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  isEditableElement,
  useKeyboardShortcuts,
  type KeyboardShortcut,
} from "./useKeyboardShortcuts";

function press(key: string, target?: HTMLElement, init: KeyboardEventInit = {}) {
  act(() => {
    (target ?? window).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

describe("isEditableElement", () => {
  it("detects form fields and contenteditable", () => {
    expect(isEditableElement(document.createElement("input"))).toBe(true);
    expect(isEditableElement(document.createElement("textarea"))).toBe(true);
    expect(isEditableElement(document.createElement("select"))).toBe(true);

    const editable = document.createElement("div");
    editable.contentEditable = "true";
    // happy-dom does not reflect the property to the attribute in all versions.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(isEditableElement(editable)).toBe(true);

    expect(isEditableElement(document.createElement("div"))).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });
});

describe("useKeyboardShortcuts", () => {
  it("invokes the handler for a matching key", () => {
    const handler = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: "j", handler }]));
    press("j");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ignores keys typed into an editable element", () => {
    const handler = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: "j", handler }]));
    const input = document.createElement("input");
    document.body.appendChild(input);
    press("j", input);
    expect(handler).not.toHaveBeenCalled();
    input.remove();
  });

  it("allows opting in to firing inside editable elements", () => {
    const handler = vi.fn();
    renderHook(() =>
      useKeyboardShortcuts([{ key: "Escape", handler, allowInEditable: true }]),
    );
    const input = document.createElement("input");
    document.body.appendChild(input);
    press("Escape", input);
    expect(handler).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it("does not fire while a modifier key is held", () => {
    const handler = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: "j", handler }]));
    press("j", undefined, { metaKey: true });
    press("j", undefined, { ctrlKey: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does nothing when disabled", () => {
    const handler = vi.fn();
    renderHook(() => useKeyboardShortcuts([{ key: "j", handler }], false));
    press("j");
    expect(handler).not.toHaveBeenCalled();
  });

  it("uses the latest handlers without rebinding", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ handler }: { handler: KeyboardShortcut["handler"] }) =>
        useKeyboardShortcuts([{ key: "j", handler }]),
      { initialProps: { handler: first } },
    );
    press("j");
    expect(first).toHaveBeenCalledTimes(1);

    rerender({ handler: second });
    press("j");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("stops listening after unmount", () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() =>
      useKeyboardShortcuts([{ key: "j", handler }]),
    );
    unmount();
    press("j");
    expect(handler).not.toHaveBeenCalled();
  });
});
