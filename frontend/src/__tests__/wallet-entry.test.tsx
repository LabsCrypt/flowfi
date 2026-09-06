import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const useWalletMock = vi.fn();

vi.mock("@/context/wallet-context", () => ({
  useWallet: () => useWalletMock(),
}));

vi.mock("@/components/wallet/WalletModal", () => ({
  WalletModal: () => <div data-testid="wallet-modal">connect your wallet</div>,
}));

vi.mock("@/components/dashboard/dashboard-view", () => ({
  DashboardView: () => <div data-testid="dashboard-view">dashboard</div>,
}));

import { WalletEntry } from "../components/wallet/wallet-entry";

describe("WalletEntry", () => {
  it("shows a loading state before hydration instead of the dashboard or modal", () => {
    useWalletMock.mockReturnValue({
      status: "disconnected",
      session: null,
      isHydrated: false,
      disconnect: vi.fn(),
    });

    render(<WalletEntry />);

    expect(screen.getByText(/loading wallet session/i)).toBeInTheDocument();
    expect(screen.queryByTestId("wallet-modal")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-view")).not.toBeInTheDocument();
  });

  it("prompts wallet connection when hydrated with no active session", () => {
    useWalletMock.mockReturnValue({
      status: "disconnected",
      session: null,
      isHydrated: true,
      disconnect: vi.fn(),
    });

    render(<WalletEntry />);

    expect(screen.getByTestId("wallet-modal")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-view")).not.toBeInTheDocument();
  });

  it("renders the dashboard when hydrated with a connected session", () => {
    useWalletMock.mockReturnValue({
      status: "connected",
      session: { publicKey: "GABC" },
      isHydrated: true,
      disconnect: vi.fn(),
    });

    render(<WalletEntry />);

    expect(screen.getByTestId("dashboard-view")).toBeInTheDocument();
    expect(screen.queryByTestId("wallet-modal")).not.toBeInTheDocument();
  });
});
