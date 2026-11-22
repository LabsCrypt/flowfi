import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren } from "react";

// `settings-content` reads the contract address at module scope, so the value
// has to be present before the component module is evaluated.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STREAM_CONTRACT_ID =
    "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4";
});

const push = vi.fn();
const disconnect = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

const walletState = vi.hoisted(() => ({
  session: {
    publicKey: "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7",
    network: "TESTNET",
    walletName: "Freighter",
  } as { publicKey: string; network: string; walletName: string } | null,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...props }: PropsWithChildren<{ href: string }>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("react-hot-toast", () => {
  const toast = (...args: unknown[]) => {
    void args;
  };
  toast.success = (...args: unknown[]) => toastSuccess(...args);
  toast.error = (...args: unknown[]) => toastError(...args);
  toast.loading = vi.fn();
  return { default: toast };
});

vi.mock("@/context/wallet-context", () => ({
  useWallet: () => ({
    session: walletState.session,
    disconnect,
    isHydrated: true,
  }),
}));

vi.mock("@/lib/wallet", () => ({
  shortenPublicKey: (key: string) => `${key.slice(0, 4)}...${key.slice(-4)}`,
  formatNetwork: (network: string) => network,
  STELLAR_NETWORK: "TESTNET",
}));

vi.mock("@/lib/api/_shared", () => ({
  getApiBaseUrl: () => "http://localhost:4000",
}));

import SettingsContent from "../settings-content";

function getThemeButtons(): HTMLElement[] {
  return screen
    .getAllByRole("button")
    .filter(
      (button) =>
        button.textContent === "Light" ||
        button.textContent === "Dark" ||
        button.textContent === "System",
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
  return screen.getByRole("button", { name: /disconnect wallet/i });
}

/** Opens the disconnect modal and clicks its confirm button. */
function confirmDisconnect() {
  act(() => {
    fireEvent.click(getDisconnectButton());
  });
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: /^disconnect$/i }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  walletState.session = {
    publicKey: "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7",
    network: "TESTNET",
    walletName: "Freighter",
  };
  localStorage.clear();
  localStorage.setItem("flowfi-theme", "dark");
  localStorage.setItem("flowfi-currency", "USD");
  localStorage.setItem("flowfi-amount-format", "full");
  localStorage.setItem("flowfi-decimal-places", "7");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("network disabled in tests")),
  );
  vi.spyOn(window, "confirm").mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SettingsContent disconnect confirmation", () => {
  it("opens the confirmation modal instead of disconnecting immediately", () => {
    render(<SettingsContent />);

    fireEvent.click(getDisconnectButton());

    expect(
      screen.getByRole("heading", { name: /disconnect wallet\?/i }),
    ).toBeInTheDocument();
    expect(disconnect).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("closes the modal without disconnecting when Cancel is clicked", () => {
    render(<SettingsContent />);

    fireEvent.click(getDisconnectButton());
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(
      screen.queryByRole("heading", { name: /disconnect wallet\?/i }),
    ).not.toBeInTheDocument();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("disconnects and redirects to home when confirmed", () => {
    render(<SettingsContent />);

    fireEvent.click(getDisconnectButton());
    fireEvent.click(screen.getByRole("button", { name: /^disconnect$/i }));

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("/");
  });
});

describe("SettingsContent draft-and-save dirty-state handling", () => {
  it("starts clean (not dirty) on initial render", () => {
    render(<SettingsContent />);

    expect(getSaveButton()).toBeDisabled();

    // Disconnect without changes — no confirmation needed.
    confirmDisconnect();

    expect(window.confirm).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/");
  });

  it("detects dirty state when theme is changed", () => {
    render(<SettingsContent />);

    const lightButton = getThemeButtons().find((button) => button.textContent === "Light");
    expect(lightButton).toBeDefined();

    act(() => {
      fireEvent.click(lightButton!);
    });

    expect(getSaveButton()).toBeEnabled();

    // Navigate away while dirty — confirm fires and the user declines.
    confirmDisconnect();

    expect(window.confirm).toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("accepts navigation when the user confirms leaving with unsaved changes", () => {
    vi.mocked(window.confirm).mockReturnValue(true);

    render(<SettingsContent />);

    act(() => {
      fireEvent.click(getThemeButtons().find((button) => button.textContent === "Light")!);
    });

    confirmDisconnect();

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

    confirmDisconnect();

    expect(window.confirm).toHaveBeenCalled();
  });

  it("detects dirty state when amount format is changed", () => {
    render(<SettingsContent />);

    const compactButton = screen
      .getAllByRole("button")
      .find((button) => button.textContent?.includes("Compact"));
    expect(compactButton).toBeDefined();

    act(() => {
      fireEvent.click(compactButton!);
    });

    expect(getSaveButton()).toBeEnabled();
  });

  it("detects dirty state when decimal places is changed", () => {
    render(<SettingsContent />);

    const fourDecimalButton = screen
      .getAllByRole("button")
      .find((button) => button.textContent?.includes("4 decimals"));
    expect(fourDecimalButton).toBeDefined();

    act(() => {
      fireEvent.click(fourDecimalButton!);
    });

    expect(getSaveButton()).toBeEnabled();
  });

  it("saving changes persists the draft and clears the dirty state", () => {
    render(<SettingsContent />);

    act(() => {
      fireEvent.click(getThemeButtons().find((button) => button.textContent === "Light")!);
    });
    act(() => {
      fireEvent.click(getSaveButton());
    });

    expect(localStorage.getItem("flowfi-theme")).toBe("light");
    expect(getSaveButton()).toBeDisabled();

    confirmDisconnect();

    expect(window.confirm).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalled();
  });

  it("guards internal link navigation when dirty (not connected)", () => {
    walletState.session = null;
    render(<SettingsContent />);

    // Pristine — internal link navigation is not blocked.
    act(() => {
      fireEvent.click(getConnectWalletLink());
    });
    expect(window.confirm).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(getThemeButtons().find((button) => button.textContent === "Light")!);
    });
    act(() => {
      fireEvent.click(getConnectWalletLink());
    });

    expect(window.confirm).toHaveBeenCalled();
  });
});

describe("SettingsContent clipboard copy", () => {
  function stubClipboard(writeText: ReturnType<typeof vi.fn>) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  }

  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
  });

  it("shows an error toast when copying the wallet address is denied", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error("Permission denied"));
    stubClipboard(writeText);

    render(<SettingsContent />);

    await user.click(screen.getByRole("button", { name: /copy wallet address/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Failed to copy to clipboard"),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("shows a success toast when copying the wallet address succeeds", async () => {
    const user = userEvent.setup();
    stubClipboard(vi.fn().mockResolvedValue(undefined));

    render(<SettingsContent />);

    await user.click(screen.getByRole("button", { name: /copy wallet address/i }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Address copied to clipboard"),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows an error toast when copying the contract address is denied", async () => {
    const user = userEvent.setup();
    stubClipboard(vi.fn().mockRejectedValue(new Error("Permission denied")));

    render(<SettingsContent />);

    await user.click(screen.getByRole("button", { name: /copy contract address/i }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Failed to copy to clipboard"),
    );
  });

  it("copies the configured contract address", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    render(<SettingsContent />);

    await user.click(screen.getByRole("button", { name: /copy contract address/i }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4",
      ),
    );
    expect(toastSuccess).toHaveBeenCalledWith("Contract address copied");
  });
});
