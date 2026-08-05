import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import React from "react";

// ─── Mocks ──────────────────────────────────────────────────────────────

const push = vi.fn();
const disconnect = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

let mockSession: {
  publicKey: string;
  network: string;
  walletName: string;
} | null = {
  publicKey: "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7",
  network: "TESTNET",
  walletName: "Freighter",
};

vi.mock("@/context/wallet-context", () => ({
  useWallet: () => ({
    session: mockSession,
    disconnect,
    isHydrated: true,
  }),
}));

vi.mock("@/lib/wallet", () => ({
  shortenPublicKey: (key: string) => `${key.slice(0, 4)}...${key.slice(-4)}`,
  formatNetwork: (n: string) => n,
  STELLAR_NETWORK: "TESTNET",
}));

vi.mock("@/lib/api/_shared", () => ({
  getApiBaseUrl: () => "http://localhost:4000",
}));

import SettingsContent from "../settings-content";

function getThemeButtons(): HTMLElement[] {
  const buttons = screen.getAllByRole("button");
  return buttons.filter(
    (b) =>
      b.textContent === "Light" ||
      b.textContent === "Dark" ||
      b.textContent === "System"
  );
}

function getCurrencySelect(): HTMLSelectElement | null {
  return screen.queryByLabelText(/default token/i) as HTMLSelectElement | null;
}

function getSaveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /save changes/i });
}

function getConnectWalletLink(): HTMLElement {
  return screen.getByText(/connect wallet/i);
}

function getDisconnectButton(): HTMLElement {
  return screen.getByText(/disconnect wallet/i);
}

describe("SettingsContent draft-and-save dirty-state handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession = {
      publicKey: "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7",
      network: "TESTNET",
      walletName: "Freighter",
    };
    // Set default saved settings
    localStorage.clear();
    localStorage.setItem("flowfi-theme", "dark");
    localStorage.setItem("flowfi-currency", "USD");
    localStorage.setItem("flowfi-amount-format", "full");
    localStorage.setItem("flowfi-decimal-places", "7");
    vi.spyOn(window, "confirm").mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts clean (not dirty) on initial render", () => {
    render(<SettingsContent />);

    expect(getSaveButton()).toBeDisabled();

    // Disconnect without changes — no confirmation needed
    act(() => {
      fireEvent.click(getDisconnectButton());
    });

    expect(window.confirm).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/");
  });

  it("detects dirty state when theme is changed", () => {
    render(<SettingsContent />);

    const lightButton = getThemeButtons().find((b) => b.textContent === "Light");
    expect(lightButton).toBeDefined();

    act(() => {
      fireEvent.click(lightButton!);
    });

    expect(getSaveButton()).toBeEnabled();

    // Navigate away while dirty — confirm should fire (mock returns false = declined)
    act(() => {
      fireEvent.click(getDisconnectButton());
    });

    expect(window.confirm).toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("accepts navigation when the user confirms leaving with unsaved changes", () => {
    vi.mocked(window.confirm).mockReturnValue(true);

    render(<SettingsContent />);

    const lightButton = getThemeButtons().find((b) => b.textContent === "Light");
    act(() => {
      fireEvent.click(lightButton!);
    });

    act(() => {
      fireEvent.click(getDisconnectButton());
    });

    expect(window.confirm).toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/");
  });

  it("detects dirty state when display currency is changed", () => {
    render(<SettingsContent />);

    const select = getCurrencySelect();
    expect(select).not.toBeNull();

    act(() => {
      fireEvent.change(select!, { target: { value: "XLM" } });
    });

    expect(getSaveButton()).toBeEnabled();

    act(() => {
      fireEvent.click(getDisconnectButton());
    });

    expect(window.confirm).toHaveBeenCalled();
  });

  it("detects dirty state when amount format is changed", () => {
    render(<SettingsContent />);

    const compactButton = screen
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("Compact"));
    expect(compactButton).toBeDefined();

    act(() => {
      fireEvent.click(compactButton!);
    });

    expect(getSaveButton()).toBeEnabled();
  });

  it("detects dirty state when decimal places is changed", () => {
    render(<SettingsContent />);

    const fourDecimalsBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("4 decimals"));
    expect(fourDecimalsBtn).toBeDefined();

    act(() => {
      fireEvent.click(fourDecimalsBtn!);
    });

    expect(getSaveButton()).toBeEnabled();
  });

  it("saving changes persists the draft and clears the dirty state", () => {
    render(<SettingsContent />);

    const lightButton = getThemeButtons().find((b) => b.textContent === "Light");
    act(() => {
      fireEvent.click(lightButton!);
    });

    act(() => {
      fireEvent.click(getSaveButton());
    });

    expect(localStorage.getItem("flowfi-theme")).toBe("light");
    expect(getSaveButton()).toBeDisabled();

    // No longer dirty — disconnect proceeds without confirmation
    act(() => {
      fireEvent.click(getDisconnectButton());
    });

    expect(window.confirm).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
  });

  it("guards internal link navigation when dirty (not connected)", () => {
    mockSession = null;
    render(<SettingsContent />);

    // Pristine — internal link navigation is not blocked
    act(() => {
      fireEvent.click(getConnectWalletLink());
    });
    expect(window.confirm).not.toHaveBeenCalled();

    // Make a change, then try to leave via the internal link
    const lightButton = getThemeButtons().find((b) => b.textContent === "Light");
    act(() => {
      fireEvent.click(lightButton!);
    });

    act(() => {
      fireEvent.click(getConnectWalletLink());
    });

    expect(window.confirm).toHaveBeenCalled();
  });
});
