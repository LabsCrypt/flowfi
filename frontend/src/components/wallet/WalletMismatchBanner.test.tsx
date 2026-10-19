import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  WalletMismatchBanner,
  resolveSupportedNetworkId,
} from "./WalletMismatchBanner";

const mockUseWallet = vi.fn();
const mockUseNetwork = vi.fn();

vi.mock("@/context/wallet-context", () => ({
  useWallet: () => mockUseWallet(),
}));

vi.mock("@/context/NetworkContext", () => ({
  useNetwork: () => mockUseNetwork(),
}));

describe("resolveSupportedNetworkId", () => {
  it("maps mainnet and public passphrases to mainnet", () => {
    expect(resolveSupportedNetworkId("Mainnet")).toBe("mainnet");
    expect(
      resolveSupportedNetworkId("Public Global Stellar Network ; September 2015"),
    ).toBe("mainnet");
  });

  it("maps testnet and SDF testnet passphrases to testnet", () => {
    expect(resolveSupportedNetworkId("Testnet")).toBe("testnet");
    expect(resolveSupportedNetworkId("Test SDF Network ; September 2015")).toBe(
      "testnet",
    );
  });

  it("maps futurenet and sandbox strings to their respective network IDs", () => {
    expect(resolveSupportedNetworkId("Futurenet")).toBe("futurenet");
    expect(
      resolveSupportedNetworkId("Test SDF Future Network ; October 2022"),
    ).toBe("futurenet");
    expect(resolveSupportedNetworkId("Local Sandbox")).toBe("sandbox");
    expect(resolveSupportedNetworkId("Standalone Network ; February 2017")).toBe(
      "sandbox",
    );
  });

  it("returns null for unknown custom networks or empty strings", () => {
    expect(resolveSupportedNetworkId("")).toBeNull();
    expect(resolveSupportedNetworkId("Custom Private Net")).toBeNull();
  });
});

describe("WalletMismatchBanner", () => {
  const connectMock = vi.fn();
  const setNetworkIdMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when no wallet session is active", () => {
    mockUseWallet.mockReturnValue({
      session: null,
      connect: connectMock,
      selectedWalletId: null,
    });
    mockUseNetwork.mockReturnValue({
      network: { id: "testnet", name: "Testnet" },
      networkId: "testnet",
      setNetworkId: setNetworkIdMock,
      isHydrated: true,
    });

    const { container } = render(<WalletMismatchBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when wallet network matches app network", () => {
    mockUseWallet.mockReturnValue({
      session: {
        walletId: "freighter",
        publicKey: "GABC123",
        network: "Test SDF Network ; September 2015",
      },
      connect: connectMock,
      selectedWalletId: "freighter",
    });
    mockUseNetwork.mockReturnValue({
      network: { id: "testnet", name: "Testnet" },
      networkId: "testnet",
      setNetworkId: setNetworkIdMock,
      isHydrated: true,
    });

    const { container } = render(<WalletMismatchBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders role='alert' banner with bold badges for wallet and app networks when mismatched", () => {
    mockUseWallet.mockReturnValue({
      session: {
        walletId: "freighter",
        publicKey: "GABC123",
        network: "Public Global Stellar Network ; September 2015",
      },
      connect: connectMock,
      selectedWalletId: "freighter",
    });
    mockUseNetwork.mockReturnValue({
      network: { id: "testnet", name: "Testnet" },
      networkId: "testnet",
      setNetworkId: setNetworkIdMock,
      isHydrated: true,
    });

    render(<WalletMismatchBanner />);

    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();

    const walletBadge = screen.getByTestId("wallet-network-badge");
    const appBadge = screen.getByTestId("app-network-badge");
    expect(walletBadge.tagName).toBe("STRONG");
    expect(walletBadge).toHaveTextContent("Mainnet");
    expect(appBadge.tagName).toBe("STRONG");
    expect(appBadge).toHaveTextContent("Testnet");
  });

  it("updates app network setting when 'Switch App to Wallet Network' is clicked", () => {
    mockUseWallet.mockReturnValue({
      session: {
        walletId: "freighter",
        publicKey: "GABC123",
        network: "Mainnet",
      },
      connect: connectMock,
      selectedWalletId: "freighter",
    });
    mockUseNetwork.mockReturnValue({
      network: { id: "testnet", name: "Testnet" },
      networkId: "testnet",
      setNetworkId: setNetworkIdMock,
      isHydrated: true,
    });

    render(<WalletMismatchBanner />);

    const switchButton = screen.getByRole("button", {
      name: /Switch App to Wallet Network/i,
    });
    expect(switchButton).not.toBeDisabled();
    fireEvent.click(switchButton);

    expect(setNetworkIdMock).toHaveBeenCalledTimes(1);
    expect(setNetworkIdMock).toHaveBeenCalledWith("mainnet");
  });

  it("disables 'Switch App to Wallet Network' when wallet reports an unsupported custom network", () => {
    mockUseWallet.mockReturnValue({
      session: {
        walletId: "freighter",
        publicKey: "GABC123",
        network: "Custom Private Chain",
      },
      connect: connectMock,
      selectedWalletId: "freighter",
    });
    mockUseNetwork.mockReturnValue({
      network: { id: "testnet", name: "Testnet" },
      networkId: "testnet",
      setNetworkId: setNetworkIdMock,
      isHydrated: true,
    });

    render(<WalletMismatchBanner />);

    const switchButton = screen.getByRole("button", {
      name: /Switch App to Wallet Network/i,
    });
    expect(switchButton).toBeDisabled();
  });

  it("queries wallet connection on 'Re-check Connection' click and dismisses banner when resolved", () => {
    let currentSession = {
      walletId: "freighter" as const,
      publicKey: "GABC123",
      network: "Mainnet",
    };

    mockUseWallet.mockImplementation(() => ({
      session: currentSession,
      connect: connectMock,
      selectedWalletId: "freighter",
    }));
    mockUseNetwork.mockReturnValue({
      network: { id: "testnet", name: "Testnet" },
      networkId: "testnet",
      setNetworkId: setNetworkIdMock,
      isHydrated: true,
    });

    const { rerender } = render(<WalletMismatchBanner />);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    const recheckButton = screen.getByRole("button", {
      name: /Re-check Connection/i,
    });
    fireEvent.click(recheckButton);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledWith("freighter");

    // Simulate wallet session updating to match app network after re-check
    currentSession = {
      walletId: "freighter",
      publicKey: "GABC123",
      network: "Testnet",
    };
    rerender(<WalletMismatchBanner />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
