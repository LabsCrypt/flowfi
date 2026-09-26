import { useCallback, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const useWalletMock = vi.fn();

vi.mock("@/context/wallet-context", () => ({
  useWallet: () => useWalletMock(),
}));

vi.mock("@stellar/freighter-api", () => ({
  isConnected: vi.fn(async () => ({ isConnected: true })),
}));

import { WalletModal } from "./WalletModal";

/**
 * Mirrors how the modal is used in the app: a trigger button owns the open
 * state, so focus restoration has a real element to return to.
 */
function ModalHarness() {
  const [isOpen, setIsOpen] = useState(false);
  const handleClose = useCallback(() => setIsOpen(false), []);

  return (
    <>
      <button type="button" onClick={() => setIsOpen(true)}>
        Open wallet modal
      </button>
      {isOpen && <WalletModal onClose={handleClose} />}
    </>
  );
}

const openModal = async () => {
  const user = userEvent.setup();
  render(<ModalHarness />);

  const trigger = screen.getByRole("button", { name: /open wallet modal/i });
  await user.click(trigger);

  const dialog = await screen.findByRole("dialog");

  return { user, trigger, dialog };
};

describe("WalletModal keyboard accessibility", () => {
  beforeEach(() => {
    document.body.style.overflow = "";
    useWalletMock.mockReturnValue({
      wallets: [
        {
          id: "freighter",
          name: "Freighter",
          badge: "Extension",
          description: "Direct browser wallet.",
        },
        {
          id: "albedo",
          name: "Albedo",
          badge: "Web / Mobile",
          description: "Popup wallet.",
        },
      ],
      status: "disconnected",
      selectedWalletId: null,
      errorMessage: null,
      connect: vi.fn(),
      clearError: vi.fn(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    document.body.style.overflow = "";
  });

  it("moves focus into the dialog when it opens", async () => {
    const { dialog } = await openModal();

    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /close wallet modal/i }),
    );
  });

  it("keeps Tab focus inside the dialog and wraps at the last element", async () => {
    const { user, dialog, trigger } = await openModal();

    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
    );
    expect(focusable.length).toBeGreaterThan(1);

    // One full cycle plus one extra tab, so the wrap at the end is exercised.
    for (let i = 0; i <= focusable.length; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(trigger);
      expect(document.activeElement).not.toBe(document.body);
    }

    // Tabbing off the last element returns to the first, never to the trigger.
    focusable[focusable.length - 1]?.focus();
    await user.tab();
    expect(document.activeElement).toBe(focusable[0]);
  });

  it("keeps Shift+Tab focus inside the dialog and wraps at the first element", async () => {
    const { user, dialog, trigger } = await openModal();

    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
    );
    expect(focusable.length).toBeGreaterThan(1);

    for (let i = 0; i <= focusable.length; i++) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(trigger);
      expect(document.activeElement).not.toBe(document.body);
    }

    // Shift+Tab off the first element returns to the last, never to the trigger.
    focusable[0]?.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(focusable[focusable.length - 1]);
  });

  it("closes on Escape and restores focus to the element that opened it", async () => {
    const { user, trigger, dialog } = await openModal();

    // Focus has to actually leave the trigger, otherwise "restored" is vacuous.
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(trigger);

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("locks body scroll while open and releases it on close", async () => {
    const { user } = await openModal();

    expect(document.body.style.overflow).toBe("hidden");

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(document.body.style.overflow).toBe("");
  });

  it("does not close on Escape while a connection is in flight", async () => {
    useWalletMock.mockReturnValue({
      wallets: [
        {
          id: "freighter",
          name: "Freighter",
          badge: "Extension",
          description: "Direct browser wallet.",
        },
      ],
      status: "connecting",
      selectedWalletId: "freighter",
      errorMessage: null,
      connect: vi.fn(),
      clearError: vi.fn(),
    });

    const { user } = await openModal();

    await user.keyboard("{Escape}");

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
