import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

const disconnectMock = vi.fn();
const useWalletMock = vi.fn();

vi.mock("@/context/wallet-context", () => ({
  useWallet: () => useWalletMock(),
}));

vi.mock("react-hot-toast", () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import SettingsContent from "@/app/settings/settings-content";

describe("SettingsContent - Disconnect Confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWalletMock.mockReturnValue({
      session: {
        publicKey: "GC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        network: "TESTNET",
        walletName: "Freighter",
      },
      disconnect: disconnectMock,
      isHydrated: true,
    });
  });

  it("does not disconnect immediately on clicking 'Disconnect Wallet', but opens confirmation modal", () => {
    render(<SettingsContent />);

    const disconnectBtn = screen.getByRole("button", { name: /disconnect wallet/i });
    expect(disconnectBtn).toBeInTheDocument();

    fireEvent.click(disconnectBtn);

    // Confirmation modal should be visible
    expect(screen.getByRole("heading", { name: /disconnect wallet\?/i })).toBeInTheDocument();
    expect(screen.getByText(/are you sure you want to disconnect your wallet\?/i)).toBeInTheDocument();

    // disconnect function should NOT have been called yet
    expect(disconnectMock).not.toHaveBeenCalled();
  });

  it("closes confirmation modal without disconnecting when Cancel is clicked", () => {
    render(<SettingsContent />);

    const disconnectBtn = screen.getByRole("button", { name: /disconnect wallet/i });
    fireEvent.click(disconnectBtn);

    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    fireEvent.click(cancelBtn);

    // Modal should be closed
    expect(screen.queryByRole("heading", { name: /disconnect wallet\?/i })).not.toBeInTheDocument();
    expect(disconnectMock).not.toHaveBeenCalled();
  });

  it("calls disconnect and redirects to home when Disconnect is confirmed in modal", () => {
    render(<SettingsContent />);

    const disconnectBtn = screen.getByRole("button", { name: /disconnect wallet/i });
    fireEvent.click(disconnectBtn);

    // Click confirm disconnect button inside modal
    const modalConfirmBtn = screen.getByRole("button", { name: /^disconnect$/i });
    fireEvent.click(modalConfirmBtn);

    expect(disconnectMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith("/");
  });
});
