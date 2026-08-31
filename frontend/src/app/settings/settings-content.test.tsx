/**
 * Settings page ↔ useSettings() desync regression tests (Architecture #60)
 *
 * These tests document the three-way theme desync:
 *   1. SettingsContent manages its own useState + direct localStorage writes
 *   2. useSettings() has a module-level sharedSettings singleton with listeners
 *   3. When the settings page writes to localStorage, it never calls
 *      useSettings()'s setters or notifies its listeners
 *
 * Acceptance criteria:
 *   - Tests that assert correct sync FAIL today (demonstrating the desync)
 *   - Once Architecture #60 is fixed, those tests will pass
 *   - Tests that assert the current broken behavior PASS today (locking it in)
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { renderHook, act, waitFor as waitForHook } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import SettingsContent from "./settings-content";
import {
  useSettings,
  STORAGE_KEYS,
  _resetSharedSettings,
} from "@/hooks/useSettings";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/context/wallet-context", () => ({
  useWallet: vi.fn(() => ({
    session: {
      publicKey: "GABCDEF1234567890ABCDEFGHIJKLMN0123456789ABCDEF1234567890ABCDEF",
      walletName: "Freighter",
      network: "TESTNET",
      connectedAt: "2024-01-01T00:00:00Z",
      walletId: "freighter",
      mocked: false,
    },
    disconnect: vi.fn(),
    isHydrated: true,
  })),
}));

vi.mock("react-hot-toast", () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  })),
}));

vi.mock("@/lib/api/_shared", () => ({
  getApiBaseUrl: vi.fn(() => "http://localhost:3001"),
}));

vi.mock("@/components/wallet/DisconnectConfirmModal", () => ({
  DisconnectConfirmModal: vi.fn(({ onClose, onConfirm }) => (
    <div data-testid="disconnect-modal">
      <button onClick={onConfirm}>Confirm</button>
      <button onClick={onClose}>Cancel</button>
    </div>
  )),
}));

vi.mock("@/lib/wallet", () => ({
  shortenPublicKey: vi.fn((key: string) => key.slice(0, 4) + "..." + key.slice(-4)),
  formatNetwork: vi.fn((network: string) => network),
  STELLAR_NETWORK: "TESTNET",
}));

// ---------------------------------------------------------------------------
// localStorage mock (self-contained for this test file)
// ---------------------------------------------------------------------------

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value.toString();
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
  };
})();

vi.stubGlobal("localStorage", localStorageMock);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetAll() {
  localStorageMock.clear();
  _resetSharedSettings();
  document.documentElement.className = "";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Settings page ↔ useSettings desync (Architecture #60)", () => {
  beforeEach(() => {
    resetAll();
  });

  // -----------------------------------------------------------------------
  // Group 1: Tests that PASS today — they document the current broken state
  // -----------------------------------------------------------------------

  describe("current broken behavior (passes today)", () => {
    it("settings page writes theme to localStorage", async () => {
      render(<SettingsContent />);

      const lightButton = screen.getByRole("button", { name: /^Light$/i });
      fireEvent.click(lightButton);

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        "flowfi-theme",
        "light"
      );
      expect(localStorage.getItem("flowfi-theme")).toBe("light");
    });

    it("settings page writes currency to localStorage", async () => {
      render(<SettingsContent />);

      const currencySelect = screen.getByLabelText("Default Token");
      fireEvent.change(currencySelect, { target: { value: "EUR" } });

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        "flowfi-currency",
        "EUR"
      );
      expect(localStorage.getItem("flowfi-currency")).toBe("EUR");
    });

    it("settings page writes amount format to localStorage", async () => {
      render(<SettingsContent />);

      const compactButton = screen.getByRole("button", { name: /Compact/i });
      fireEvent.click(compactButton);

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        "flowfi-amount-format",
        "compact"
      );
      expect(localStorage.getItem("flowfi-amount-format")).toBe("compact");
    });

    it("settings page writes decimal places to localStorage", async () => {
      render(<SettingsContent />);

      const twoDecimalsButton = screen.getByRole("button", {
        name: /2 decimals/i,
      });
      fireEvent.click(twoDecimalsButton);

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        "flowfi-decimal-places",
        "2"
      );
      expect(localStorage.getItem("flowfi-decimal-places")).toBe("2");
    });

    it("useSettings() reads defaults when localStorage is empty", async () => {
      const { result } = renderHook(() => useSettings());

      await waitForHook(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.theme).toBe("dark");
      expect(result.current.displayCurrency).toBe("USD");
      expect(result.current.amountFormat).toBe("full");
      expect(result.current.decimalPlaces).toBe(7);
    });
  });

  // -----------------------------------------------------------------------
  // Group 2: Tests that FAIL today — the core desync demonstration
  //
  // Key insight: An ALREADY-MOUNTED useSettings() consumer does NOT see
  // changes made by the settings page. This is the three-way desync:
  //   - settings-content.tsx writes to localStorage (bypassing shared state)
  //   - useSettings() shared singleton is never notified
  //   - Existing consumers remain stale until page reload
  //
  // These tests assert the CORRECT behavior (shared state should update).
  // They FAIL today → demonstrate the desync.
  // Once #60 is fixed, they PASS.
  // -----------------------------------------------------------------------

  describe("desired sync behavior (FAILS today, passes after #60 fix)", () => {
    it("already-mounted consumer sees theme change from settings page", async () => {
      // Mount a consumer first — it reads default "dark"
      const { result: consumer } = renderHook(() => useSettings());

      await waitForHook(() => {
        expect(consumer.current.isHydrated).toBe(true);
      });

      expect(consumer.current.theme).toBe("dark");

      // Now render the settings page and change theme
      render(<SettingsContent />);

      const lightButton = screen.getByRole("button", { name: /^Light$/i });
      fireEvent.click(lightButton);

      // localStorage was updated
      expect(localStorage.getItem("flowfi-theme")).toBe("light");

      // The pre-existing consumer should see the change
      // EXPECTED TO FAIL TODAY: consumer still shows "dark"
      expect(consumer.current.theme).toBe("light");
    });

    it("already-mounted consumer sees currency change from settings page", async () => {
      const { result: consumer } = renderHook(() => useSettings());

      await waitForHook(() => {
        expect(consumer.current.isHydrated).toBe(true);
      });

      expect(consumer.current.displayCurrency).toBe("USD");

      render(<SettingsContent />);

      const currencySelect = screen.getByLabelText("Default Token");
      fireEvent.change(currencySelect, { target: { value: "EUR" } });

      expect(localStorage.getItem("flowfi-currency")).toBe("EUR");

      // EXPECTED TO FAIL TODAY
      expect(consumer.current.displayCurrency).toBe("EUR");
    });

    it("already-mounted consumer sees amount format change from settings page", async () => {
      const { result: consumer } = renderHook(() => useSettings());

      await waitForHook(() => {
        expect(consumer.current.isHydrated).toBe(true);
      });

      expect(consumer.current.amountFormat).toBe("full");

      render(<SettingsContent />);

      const compactButton = screen.getByRole("button", { name: /Compact/i });
      fireEvent.click(compactButton);

      expect(localStorage.getItem("flowfi-amount-format")).toBe("compact");

      // EXPECTED TO FAIL TODAY
      expect(consumer.current.amountFormat).toBe("compact");
    });

    it("already-mounted consumer sees decimal places change from settings page", async () => {
      const { result: consumer } = renderHook(() => useSettings());

      await waitForHook(() => {
        expect(consumer.current.isHydrated).toBe(true);
      });

      expect(consumer.current.decimalPlaces).toBe(7);

      render(<SettingsContent />);

      const twoDecimalsButton = screen.getByRole("button", {
        name: /2 decimals/i,
      });
      fireEvent.click(twoDecimalsButton);

      expect(localStorage.getItem("flowfi-decimal-places")).toBe("2");

      // EXPECTED TO FAIL TODAY
      expect(consumer.current.decimalPlaces).toBe(2);
    });

    it("settings page and existing useSettings() consumer should both reflect theme after change", async () => {
      // Mount consumer first (reads default "dark")
      const { result: consumer } = renderHook(() => useSettings());

      await waitForHook(() => {
        expect(consumer.current.isHydrated).toBe(true);
      });

      // Change theme via settings page
      render(<SettingsContent />);

      const systemButton = screen.getByRole("button", { name: /^System$/i });
      fireEvent.click(systemButton);

      // Both should show "system"
      expect(consumer.current.theme).toBe("system");
    });
  });

  // -----------------------------------------------------------------------
  // Group 3: Multi-consumer sync tests — baseline + desync
  // -----------------------------------------------------------------------

  describe("multi-consumer desync", () => {
    it("two useSettings() consumers stay in sync with each other (baseline)", async () => {
      const { result: consumerA } = renderHook(() => useSettings());
      const { result: consumerB } = renderHook(() => useSettings());

      await waitForHook(() => {
        expect(consumerA.current.isHydrated).toBe(true);
        expect(consumerB.current.isHydrated).toBe(true);
      });

      act(() => {
        consumerA.current.setTheme("light");
      });

      // Both consumers should see the change — useSettings internal sync works
      expect(consumerA.current.theme).toBe("light");
      expect(consumerB.current.theme).toBe("light");
    });

    it("settings page changes do NOT propagate to an already-mounted useSettings() consumer (THE DESYNC)", async () => {
      // Pre-seed: consumer starts at default "dark"
      const { result: consumer } = renderHook(() => useSettings());

      await waitForHook(() => {
        expect(consumer.current.isHydrated).toBe(true);
      });

      expect(consumer.current.theme).toBe("dark");

      // Now render the settings page and change the theme
      render(<SettingsContent />);

      const lightButton = screen.getByRole("button", { name: /^Light$/i });
      fireEvent.click(lightButton);

      // localStorage was updated
      expect(localStorage.getItem("flowfi-theme")).toBe("light");

      // But the useSettings consumer still shows "dark" — THIS IS THE DESYNC
      // The settings page bypassed useSettings()'s shared singleton
      expect(consumer.current.theme).toBe("dark");
    });

    it("settings page currency change does NOT propagate to an already-mounted useSettings() consumer", async () => {
      const { result: consumer } = renderHook(() => useSettings());

      await waitForHook(() => {
        expect(consumer.current.isHydrated).toBe(true);
      });

      expect(consumer.current.displayCurrency).toBe("USD");

      render(<SettingsContent />);

      const currencySelect = screen.getByLabelText("Default Token");
      fireEvent.change(currencySelect, { target: { value: "XLM" } });

      expect(localStorage.getItem("flowfi-currency")).toBe("XLM");

      // Consumer is stale — desync
      expect(consumer.current.displayCurrency).toBe("USD");
    });

    it("settings page format change does NOT propagate to an already-mounted useSettings() consumer", async () => {
      const { result: consumer } = renderHook(() => useSettings());

      await waitForHook(() => {
        expect(consumer.current.isHydrated).toBe(true);
      });

      expect(consumer.current.amountFormat).toBe("full");

      render(<SettingsContent />);

      const compactButton = screen.getByRole("button", { name: /Compact/i });
      fireEvent.click(compactButton);

      expect(localStorage.getItem("flowfi-amount-format")).toBe("compact");

      // Consumer is stale — desync
      expect(consumer.current.amountFormat).toBe("full");
    });

    it("settings page decimal places change does NOT propagate to an already-mounted useSettings() consumer", async () => {
      const { result: consumer } = renderHook(() => useSettings());

      await waitForHook(() => {
        expect(consumer.current.isHydrated).toBe(true);
      });

      expect(consumer.current.decimalPlaces).toBe(7);

      render(<SettingsContent />);

      const fourDecimalsButton = screen.getByRole("button", {
        name: /4 decimals/i,
      });
      fireEvent.click(fourDecimalsButton);

      expect(localStorage.getItem("flowfi-decimal-places")).toBe("4");

      // Consumer is stale — desync
      expect(consumer.current.decimalPlaces).toBe(7);
    });
  });
});
