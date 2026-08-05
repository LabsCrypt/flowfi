import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, screen } from "@testing-library/react";
import React from "react";
import { useUnsavedChangesGuard } from "./useUnsavedChangesGuard";

function Harness({ dirty }: { dirty: boolean }) {
  useUnsavedChangesGuard(dirty);
  return (
    <div>
      <a href="/dashboard">Internal</a>
      <a href="/dashboard?ref=1">Internal query</a>
      <a href="https://example.com">External</a>
      <a href="mailto:test@example.com">Email</a>
      <a href="tel:+1234567890">Phone</a>
      <a href="javascript:alert(1)">JS scheme</a>
      <a href="data:text/html,alert(1)">Data scheme</a>
      <a href="vbscript:msgbox(1)">VBScript scheme</a>
      <a href="#section">Anchor</a>
      <a href="https://example.com" target="_blank" rel="noreferrer">
        New tab
      </a>
    </div>
  );
}

const LINKS_WITH_EXPECTATION: Array<[string, boolean]> = [
  ["Internal", true],
  ["Internal query", true],
  ["External", false],
  ["Email", false],
  ["Phone", false],
  ["JS scheme", false],
  ["Data scheme", false],
  ["VBScript scheme", false],
  ["Anchor", false],
  ["New tab", false],
];

describe("useUnsavedChangesGuard internal-link interception", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "confirm").mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("only confirms internal http(s) navigations when dirty", () => {
    render(<Harness dirty />);

    for (const [text, shouldConfirm] of LINKS_WITH_EXPECTATION) {
      const callsBefore = vi.mocked(window.confirm).mock.calls.length;
      act(() => {
        fireEvent.click(screen.getByText(text));
      });
      const confirmed = vi.mocked(window.confirm).mock.calls.length > callsBefore;
      expect(confirmed, `${text} should${shouldConfirm ? "" : " not"} confirm`).toBe(
        shouldConfirm
      );
    }
  });

  it("never confirms when there are no unsaved changes", () => {
    render(<Harness dirty={false} />);

    for (const [text] of LINKS_WITH_EXPECTATION) {
      act(() => {
        fireEvent.click(screen.getByText(text));
      });
    }

    expect(window.confirm).not.toHaveBeenCalled();
  });
});
