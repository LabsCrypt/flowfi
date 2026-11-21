import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";

import { ShareAddressModal } from "./ShareAddressModal";

// The modal was a bare div with an icon-only close button (#1882): no dialog
// role, so a screen reader announced nothing when it opened, and no focus
// handling, so Tab walked straight out into the page behind it.

const ADDRESS = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

function renderModal(onClose = vi.fn()) {
  render(<ShareAddressModal address={ADDRESS} onClose={onClose} />);
  return { onClose };
}

describe("ShareAddressModal", () => {
  it("is a labelled modal dialog", () => {
    renderModal();
    const dialog = screen.getByRole("dialog");

    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)?.textContent).toContain(
      "Share Payment Address",
    );
  });

  it("gives the close button an accessible name", () => {
    renderModal();
    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
  });

  it("closes on Escape and on the close button", async () => {
    const user = userEvent.setup();
    const { onClose } = renderModal();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("moves focus into the dialog and keeps Tab inside it", async () => {
    const user = userEvent.setup();
    renderModal();

    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);

    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("shows the address and offers to copy it", () => {
    renderModal();
    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });
});
