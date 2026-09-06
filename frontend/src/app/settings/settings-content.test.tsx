import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PropsWithChildren } from "react";

const toastError = vi.fn();
const toastSuccess = vi.fn();
const toastBase = vi.fn();

const mockSession = {
  publicKey: "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7",
  network: "TESTNET",
  walletName: "Freighter",
};

vi.mock("@/context/wallet-context", () => ({
  useWallet: () => ({
    session: mockSession,
    disconnect: vi.fn(),
    isHydrated: true,
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: PropsWithChildren<Record<string, unknown>>) => (
    <a {...rest}>{children}</a>
  ),
}));

vi.mock("react-hot-toast", () => {
  const fn = (...args: unknown[]) => toastBase(...args);
  fn.success = (...args: unknown[]) => toastSuccess(...args);
  fn.error = (...args: unknown[]) => toastError(...args);
  return { default: fn };
});

vi.mock("@/lib/api/_shared", () => ({
  getApiBaseUrl: () => "http://localhost:4000",
}));

import SettingsContent from "./settings-content";

describe("SettingsContent clipboard copy", () => {
  const originalClipboard = navigator.clipboard;

  beforeEach(() => {
    toastError.mockClear();
    toastSuccess.mockClear();
    toastBase.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network disabled in tests")),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
  });

  it("shows an error toast instead of failing silently when copying the wallet address is denied", async () => {
    // userEvent.setup() installs its own clipboard stub, so it must run
    // before we install ours or it will clobber this mock.
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(<SettingsContent />);

    await user.click(screen.getByRole("button", { name: /copy wallet address/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(mockSession.publicKey);
    });
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Failed to copy to clipboard");
    });
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /address copied$/i })).not.toBeInTheDocument();
  });

  it("shows a success toast when copying the wallet address succeeds", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(<SettingsContent />);

    await user.click(screen.getByRole("button", { name: /copy wallet address/i }));

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith("Address copied to clipboard");
    });
    expect(toastError).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /^address copied$/i })).toBeInTheDocument();
  });

  it("shows an error toast instead of failing silently when copying the contract address is denied", async () => {
    // userEvent.setup() installs its own clipboard stub, so it must run
    // before we install ours or it will clobber this mock.
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(<SettingsContent />);

    await user.click(screen.getByRole("button", { name: /copy contract address/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Failed to copy to clipboard");
    });
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("shows a success toast when copying the contract address succeeds", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    render(<SettingsContent />);

    await user.click(screen.getByRole("button", { name: /copy contract address/i }));

    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith("Contract address copied");
    });
    expect(toastError).not.toHaveBeenCalled();
  });
});
