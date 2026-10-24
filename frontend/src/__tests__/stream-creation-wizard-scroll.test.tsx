import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/api/_shared", () => ({
  getApiBaseUrl: () => "http://localhost:4001",
}));

vi.mock("@/lib/soroban", () => ({
  fetchTokenBalanceDisplay: vi.fn().mockResolvedValue("1000"),
  toBaseUnits: vi.fn((v: string) => BigInt(v)),
}));

vi.mock("@/lib/stellar", () => ({
  isValidStellarPublicKey: vi.fn((v: string) => v.startsWith("G") && v.length >= 56),
}));

vi.mock("@/components/ui/Button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    loading,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    glow?: boolean;
    variant?: string;
    loading?: boolean;
    children?: React.ReactNode;
  }) => (
    <button onClick={onClick} disabled={disabled || loading} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/Stepper", () => ({
  Stepper: ({ steps, currentStep }: { steps: string[]; currentStep: number }) => (
    <div data-testid="stepper">
      {steps.map((s, i) => (
        <span key={s} data-active={i + 1 === currentStep}>
          {s}
        </span>
      ))}
    </div>
  ),
}));

vi.mock("@/components/stream-creation/RecipientStep", () => ({
  RecipientStep: () => <div data-testid="recipient-step">RecipientStep</div>,
}));

vi.mock("@/components/stream-creation/TokenStep", () => ({
  TokenStep: () => <div data-testid="token-step">TokenStep</div>,
}));

vi.mock("@/components/stream-creation/AmountStep", () => ({
  AmountStep: () => <div data-testid="amount-step">AmountStep</div>,
}));

vi.mock("@/components/stream-creation/ScheduleStep", () => ({
  ScheduleStep: () => <div data-testid="schedule-step">ScheduleStep</div>,
}));

vi.mock("@/components/stream-creation/TemplateStep", () => ({
  TemplateStep: () => <div data-testid="template-step">TemplateStep</div>,
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { StreamCreationWizard } from "../components/stream-creation/StreamCreationWizard";

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("StreamCreationWizard scroll-to-top", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scrolls the wizard's own container, not a different .glass-card element", () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();

    // Render the wizard alongside a sibling .glass-card to prove the scroll
    // targets the wizard's own dialogRef, not the first .glass-card in the DOM.
    const { container } = render(
      <>
        <div className="glass-card" data-testid="unrelated-card">
          Unrelated card that should NOT be scrolled
        </div>
        <StreamCreationWizard onClose={onClose} onSubmit={onSubmit} />
      </>
    );

    // The wizard's scrollable container is the inner div with glass-card + overflow-y-auto.
    // It's the element that has `role="dialog"` on its parent and `max-h-[90vh] overflow-y-auto`.
    const wizardContainer = container.querySelector(
      ".glass-card.max-h-\\[90vh\\]"
    ) as HTMLElement;
    expect(wizardContainer).toBeTruthy();

    // Spy on scrollTo of the wizard's own container
    const wizardScrollSpy = vi.fn();
    wizardContainer.scrollTo = wizardScrollSpy;

    // Also spy on scrollTo of the unrelated card
    const unrelatedCard = screen.getByTestId("unrelated-card");
    const unrelatedScrollSpy = vi.fn();
    (unrelatedCard as HTMLElement).scrollTo = unrelatedScrollSpy;

    // Step 1 is Template (no validation required), so Next should advance
    fireEvent.click(screen.getByText("Next"));

    // The wizard's own container should have been scrolled to top
    expect(wizardScrollSpy).toHaveBeenCalledWith({
      top: 0,
      behavior: "smooth",
    });

    // The unrelated .glass-card should NOT have been scrolled
    expect(unrelatedScrollSpy).not.toHaveBeenCalled();
  });

  it("does not query the global DOM for .glass-card when scrolling", () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();

    // Spy on document.querySelector to detect any .glass-card queries
    const originalQuerySelector = document.querySelector.bind(document);
    const querySelectorSpy = vi.fn((selector: string) => {
      // Let normal selectors pass through, but fail any .glass-card query
      if (selector === ".glass-card") {
        throw new Error(
          "BUG: document.querySelector('.glass-card') should not be called — use dialogRef instead"
        );
      }
      return originalQuerySelector(selector);
    });
    document.querySelector = querySelectorSpy as typeof document.querySelector;

    try {
      render(
        <StreamCreationWizard onClose={onClose} onSubmit={onSubmit} />
      );

      // Advance to step 2 — this should NOT trigger document.querySelector('.glass-card')
      fireEvent.click(screen.getByText("Next"));

      // Verify no .glass-card query was made
      const glassCardCalls = querySelectorSpy.mock.calls.filter(
        ([selector]) => selector === ".glass-card"
      );
      expect(glassCardCalls).toHaveLength(0);
    } finally {
      document.querySelector = originalQuerySelector;
    }
  });
});
