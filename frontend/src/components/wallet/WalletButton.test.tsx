import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const useWalletMock = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("@/context/wallet-context", () => ({
  useWallet: () => useWalletMock(),
}));

vi.mock("react-hot-toast", () => ({
  default: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

import { WalletButton } from "./WalletButton";

const SESSION = {
  walletId: "freighter" as const,
  walletName: "Freighter",
  publicKey: "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOP",
  connectedAt: new Date().toISOString(),
  network: "Testnet",
  mocked: false,
};

describe("WalletButton clipboard copy", () => {
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    toastError.mockClear();
    toastSuccess.mockClear();
    useWalletMock.mockReturnValue({
      status: "connected",
      session: SESSION,
      disconnect: vi.fn(),
      isHydrated: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
  });

  it("shows an error toast instead of failing silently when the clipboard write is denied", async () => {
    // userEvent.setup() installs its own clipboard stub, so it must run
    // before we install ours or it will clobber this mock.
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(<WalletButton />);

    // Open the wallet chip dropdown that contains the "Copy" button.
    await user.click(screen.getByTitle(SESSION.publicKey));

    const copyButton = await screen.findByRole("button", { name: /copy/i });
    await user.click(copyButton);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(SESSION.publicKey);
    });

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Failed to copy to clipboard");
    });
    expect(toastSuccess).not.toHaveBeenCalled();

    // Local "copied" feedback must not fire on failure.
    expect(screen.queryByRole("button", { name: /copied!/i })).not.toBeInTheDocument();
  });

  it("shows a success toast and toggles the copied label when the write succeeds", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(<WalletButton />);

    await user.click(screen.getByTitle(SESSION.publicKey));
    const copyButton = await screen.findByRole("button", { name: /copy/i });
    await user.click(copyButton);

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith("Address copied to clipboard");
    });
    expect(toastError).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /copied!/i })).toBeInTheDocument();
  });
});
