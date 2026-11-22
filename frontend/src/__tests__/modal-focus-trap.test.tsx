import React, { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/context/wallet-context", () => ({
  useWallet: () => ({ session: null }),
}));

vi.mock("@/lib/soroban", () => ({
  batchWithdrawFromStreams: vi.fn(),
}));

vi.mock("@/lib/api/webhooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/webhooks")>()),
  listWebhookDeliveries: vi.fn().mockResolvedValue({ deliveries: [], total: 0, page: 1, limit: 20 }),
  sendWebhookTest: vi.fn(),
}));

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import { KeyboardShortcutsModal } from "@/components/dashboard/KeyboardShortcutsModal";
import { BatchClaimDrawer } from "@/components/dashboard/BatchClaimDrawer";
import { WebhookModal } from "@/components/webhooks/WebhookModal";
import { WebhookDeliveryModal } from "@/components/webhooks/WebhookDeliveryModal";
import type { WebhookSubscription } from "@/lib/api/webhooks";
import type { Stream } from "@/lib/dashboard";

// #1887 — the four overlays that used to bypass useModalDialog.

const webhook: WebhookSubscription = {
  id: "sub-1",
  userAddress: "GUSER",
  targetUrl: "https://example.com/hook",
  eventTypes: ["STREAM_CREATED"],
  isActive: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const claimableStream: Stream = {
  id: "7",
  recipient: "GRECIPIENT",
  amount: 1000,
  token: "USDC",
  status: "Active",
  deposited: 1000,
  withdrawn: 0,
  date: "2026-01-01",
  ratePerSecond: 1,
  lastUpdateTime: Math.floor(Date.now() / 1000) - 60,
  isActive: true,
};

type Overlay = {
  name: string;
  render: (onClose: () => void) => React.ReactNode;
};

const overlays: Overlay[] = [
  {
    name: "Keyboard shortcuts",
    render: (onClose) => <KeyboardShortcutsModal open onClose={onClose} />,
  },
  {
    name: "Batch claim",
    render: (onClose) => (
      <BatchClaimDrawer streams={[claimableStream]} onClose={onClose} onSuccess={() => {}} />
    ),
  },
  {
    name: "Register webhook",
    render: (onClose) => (
      <WebhookModal userAddress="GUSER" onClose={onClose} onSave={() => Promise.resolve()} />
    ),
  },
  {
    name: "Delivery logs",
    render: (onClose) => (
      <WebhookDeliveryModal subscription={webhook} userAddress="GUSER" onClose={onClose} />
    ),
  },
];

function Harness({ overlay }: { overlay: Overlay }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open overlay
      </button>
      <button type="button">Background action</button>
      {open && overlay.render(() => setOpen(false))}
    </>
  );
}

async function openOverlay(overlay: Overlay) {
  const user = userEvent.setup();
  render(<Harness overlay={overlay} />);
  const trigger = screen.getByRole("button", { name: "Open overlay" });
  await user.click(trigger);
  const dialog = screen.getByRole("dialog", { name: overlay.name });
  return { user, trigger, dialog };
}

describe.each(overlays)("$name overlay", (overlay) => {
  it("is a modal dialog named by its heading", async () => {
    const { dialog } = await openOverlay(overlay);

    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)).toHaveTextContent(overlay.name);
  });

  it("moves focus into the dialog when it opens", async () => {
    const { dialog } = await openOverlay(overlay);

    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("traps Tab and Shift+Tab inside the dialog", async () => {
    const { user, dialog } = await openOverlay(overlay);

    for (let i = 0; i < 12; i += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    for (let i = 0; i < 12; i += 1) {
      await user.tab({ shift: true });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const { user, trigger } = await openOverlay(overlay);

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: overlay.name })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe("useModalDialog consumers re-rendered by their parent", () => {
  it("keep focus where the user put it when onClose changes identity", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <BatchClaimDrawer streams={[claimableStream]} onClose={() => {}} onSuccess={() => {}} />,
    );

    const selectAll = screen.getByRole("checkbox", { name: "Select all" });
    await user.click(selectAll);
    expect(selectAll).toHaveFocus();

    // A parent re-render passes a fresh inline onClose, as dashboard-view does.
    rerender(
      <BatchClaimDrawer streams={[claimableStream]} onClose={() => {}} onSuccess={() => {}} />,
    );

    expect(selectAll).toHaveFocus();
  });
});
