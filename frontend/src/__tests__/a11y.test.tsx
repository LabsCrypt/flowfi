import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import axe, { type AxeResults } from "axe-core";

vi.mock("@/context/wallet-context", () => ({
  useWallet: () => ({
    wallets: [],
    status: "disconnected",
    selectedWalletId: null,
    errorMessage: null,
    connect: vi.fn(),
    clearError: vi.fn(),
    isConnected: vi.fn().mockResolvedValue({ isConnected: false }),
  }),
}));

vi.mock("@/lib/api/webhooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/webhooks")>()),
  listWebhookDeliveries: vi.fn().mockResolvedValue({ deliveries: [], total: 0, page: 1, limit: 20 }),
}));

vi.mock("@stellar/freighter-api", () => ({
  isConnected: () => Promise.resolve({ isConnected: false }),
}));

// #1198 — Automated accessibility suite.
//
// Renders the primary interactive surfaces in happy-dom and asserts that axe
// reports zero critical/serious violations. `color-contrast` and any rule that
// depends on real browser layout (canvas-based color computation, native
// widget rendering) is disabled here because happy-dom cannot reproduce
// computed styles/canvas; the visual contrast audit is enforced separately via
// the dark-mode token changes and a browser-based Playwright run.

import { IncomingStreamCard } from "@/components/streams/IncomingStreamCard";
import { StreamDetailsModal } from "@/components/dashboard/StreamDetailsModal";
import { TopUpModal } from "@/components/stream-creation/TopUpModal";
import { WalletModal } from "@/components/wallet/WalletModal";
import { KeyboardShortcutsModal } from "@/components/dashboard/KeyboardShortcutsModal";
import { BatchClaimDrawer } from "@/components/dashboard/BatchClaimDrawer";
import { WebhookModal } from "@/components/webhooks/WebhookModal";
import { WebhookDeliveryModal } from "@/components/webhooks/WebhookDeliveryModal";
import type { WebhookSubscription } from "@/lib/api/webhooks";
import type { IncomingStreamRecord } from "@/lib/api/streams";
import type { Stream } from "@/lib/dashboard";

const AXE_RULES = (() => {
  const disabled: {
    [key: string]: { enabled: false };
  } = {
    "color-contrast": { enabled: false },
  };
  return disabled;
})();

async function assertNoCriticalOrSerious(container: HTMLElement) {
  const results: AxeResults = await axe.run(container, {
    rules: AXE_RULES,
    resultTypes: ["violations"],
  });
  const failures = results.violations.filter((v) =>
    v.impact === "critical" || v.impact === "serious"
  );
  expect(
    failures.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
  ).toEqual([]);
}

const streamRecord: IncomingStreamRecord = {
  id: "stream-1",
  streamId: 1,
  sender: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
  senderDisplay: "alice*stellar",
  token: "USDC",
  tokenAddress: "CAS3FLKZ2N6YUFY66TKSXJQVOTLNOB4IIBW7YHDWQ7M5AGPB2QRUUAAA",
  ratePerSecond: 0.5,
  deposited: 1000,
  withdrawn: 0,
  startTime: Math.floor(Date.now() / 1000) - 3600,
  lastUpdateTime: Math.floor(Date.now() / 1000),
  isActive: true,
  isPaused: false,
  pausedAt: null,
  totalPausedDuration: 0,
  status: "Active",
};

const mockStream: Stream = {
  id: "stream-1",
  recipient: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
  amount: 1000,
  token: "USDC",
  status: "Active",
  deposited: 1000,
  withdrawn: 250,
  date: "2026-08-30",
  ratePerSecond: 0.5,
  lastUpdateTime: Math.floor(Date.now() / 1000),
  isActive: true,
};

afterEach(() => cleanup());

describe("Accessibility (axe-core) — critical & serious violations", () => {
  it("IncomingStreamCard is accessible", async () => {
    const { container } = render(
      <IncomingStreamCard
        stream={{ ...streamRecord, isActive: false, status: "Completed" }}
        withdrawing={false}
        onWithdraw={() => {}}
      />,
    );
    await assertNoCriticalOrSerious(container);
  });

  it("StreamDetailsModal is accessible with focusable content", async () => {
    const { container } = render(
      <StreamDetailsModal
        stream={mockStream}
        onClose={() => {}}
        onCancelClick={() => {}}
        onTopUpClick={() => {}}
      />,
    );

    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[aria-modal="true"]')).not.toBeNull();

    await assertNoCriticalOrSerious(container);
  });

  it("TopUpModal is accessible", async () => {
    const { container } = render(
      <TopUpModal
        streamId="stream-1"
        token="USDC"
        currentDeposited={1000}
        onConfirm={() => Promise.resolve()}
        onClose={() => {}}
      />,
    );
    await assertNoCriticalOrSerious(container);
  });

  it("WalletModal is accessible", async () => {
    const { container } = render(<WalletModal onClose={() => {}} />);
    await assertNoCriticalOrSerious(container);
  });

  describe("overlays routed through useModalDialog (#1887)", () => {
    const webhook: WebhookSubscription = {
      id: "sub-1",
      userAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
      targetUrl: "https://example.com/hook",
      eventTypes: ["STREAM_CREATED"],
      isActive: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    function expectNamedModalDialog(container: HTMLElement, name: string) {
      const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(dialog).toHaveAccessibleName(name);
    }

    it("KeyboardShortcutsModal is accessible", async () => {
      const { container } = render(<KeyboardShortcutsModal open onClose={() => {}} />);
      expectNamedModalDialog(container, "Keyboard shortcuts");
      await assertNoCriticalOrSerious(container);
    });

    it("BatchClaimDrawer is accessible", async () => {
      const { container } = render(
        <BatchClaimDrawer
          streams={[{ ...mockStream, lastUpdateTime: Math.floor(Date.now() / 1000) - 60 }]}
          onClose={() => {}}
          onSuccess={() => {}}
        />,
      );
      expectNamedModalDialog(container, "Batch claim");
      await assertNoCriticalOrSerious(container);
    });

    it("WebhookModal is accessible", async () => {
      const { container } = render(
        <WebhookModal
          userAddress={webhook.userAddress}
          onClose={() => {}}
          onSave={() => Promise.resolve()}
        />,
      );
      expectNamedModalDialog(container, "Register webhook");
      await assertNoCriticalOrSerious(container);
    });

    it("WebhookDeliveryModal is accessible", async () => {
      const { container } = render(
        <WebhookDeliveryModal
          subscription={webhook}
          userAddress={webhook.userAddress}
          onClose={() => {}}
        />,
      );
      expectNamedModalDialog(container, "Delivery logs");
      await assertNoCriticalOrSerious(container);
    });
  });
});
