import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DashboardSettings } from "./DashboardSettings";
import type { WalletSession } from "@/lib/wallet";

const session: WalletSession = {
  walletId: "freighter",
  walletName: "Freighter",
  publicKey: "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABC",
  connectedAt: "2026-11-21T00:00:00.000Z",
  network: "testnet",
  mocked: false,
};

function renderSettings() {
  return render(<DashboardSettings session={session} onDisconnect={vi.fn()} />);
}

describe("DashboardSettings form labeling (#632)", () => {
  it("associates the template name input with a label via id + htmlFor", () => {
    const { container } = renderSettings();

    const input = screen.getByLabelText("Template name");
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe("INPUT");
    expect(input).toHaveAttribute("id", "stream-template-name");

    const label = container.querySelector<HTMLLabelElement>(
      'label[for="stream-template-name"]',
    );
    expect(label).not.toBeNull();
    expect(label?.textContent?.trim()).toBe("Template name");
  });

  it("keeps the label visually hidden so the layout is unchanged", () => {
    const { container } = renderSettings();

    const label = container.querySelector('label[for="stream-template-name"]');
    expect(label?.getAttribute("class")).toContain("sr-only");
  });

  it("gives every form control an id and a programmatic label", () => {
    const { container } = renderSettings();

    const controls = container.querySelectorAll<HTMLElement>(
      "input, textarea, select",
    );
    expect(controls.length).toBeGreaterThan(0);

    for (const control of controls) {
      expect(control.id, `${control.tagName} is missing an id`).not.toBe("");
      expect(
        container.querySelector(`label[for="${CSS.escape(control.id)}"]`),
        `${control.id} has no label targeting it`,
      ).not.toBeNull();
    }

    // Each control must resolve through its accessible name, not just markup.
    expect(screen.getAllByLabelText("Template name")).toHaveLength(1);
  });
});
