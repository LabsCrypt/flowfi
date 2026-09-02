import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn() })),
}));

vi.mock("react-hot-toast", () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/soroban", () => ({
  fetchTokenBalanceDisplay: vi.fn().mockResolvedValue("1000"),
}));

vi.mock("@/lib/stellar", () => ({
  isValidStellarPublicKey: vi.fn((val: string) => /^G[A-Z2-7]{55}$/.test(val)),
}));

vi.mock("@/utils/amount", () => ({
  hasValidPrecision: vi.fn((val: string, decimals: number) => {
    if (!val || val.trim() === "") return true;
    if (val.includes(".")) {
      const frac = val.split(".")[1];
      return frac ? frac.length <= decimals : true;
    }
    return true;
  }),
}));

vi.mock("@/hooks/useModalDialog", () => ({
  useModalDialog: vi.fn(() => ({ current: null })),
}));

vi.mock("@/lib/api/_shared", () => ({
  getApiBaseUrl: vi.fn(() => "http://localhost:3001"),
}));

vi.mock("../TemplateStep", () => ({
  TemplateStep: ({ onSelectTemplate, templates }: { onSelectTemplate: (id: string) => void; templates: Array<{ id: string; name: string }> }) => (
    <div data-testid="template-step">
      {templates.map((t) => (
        <button key={t.id} onClick={() => onSelectTemplate(t.id)}>{t.name}</button>
      ))}
    </div>
  ),
}));

vi.mock("../RecipientStep", () => ({
  RecipientStep: ({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) => (
    <div data-testid="recipient-step">
      <input
        aria-label="Recipient Address"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <span role="alert">{error}</span>}
    </div>
  ),
}));

vi.mock("../TokenStep", () => ({
  TokenStep: ({ value, error }: { value: string; onChange: (v: string) => void; error?: string }) => (
    <div data-testid="token-step">
      <span>Token: {value}</span>
      {error && <span role="alert">{error}</span>}
    </div>
  ),
}));

vi.mock("../AmountStep", () => ({
  AmountStep: ({
    value,
    onChange,
    error,
  }: {
    value: string;
    onChange: (v: string) => void;
    error?: string;
    token?: string;
  }) => (
    <div data-testid="amount-step">
      <input
        aria-label="Amount"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <span role="alert">{error}</span>}
    </div>
  ),
}));

vi.mock("../ScheduleStep", () => ({
  ScheduleStep: ({
    duration,
    onDurationChange,
    error,
  }: {
    duration: string;
    onDurationChange: (v: string) => void;
    error?: string;
    durationUnit?: string;
    amount?: string;
    token?: string;
    onUnitChange?: (v: string) => void;
  }) => (
    <div data-testid="schedule-step">
      <input
        aria-label="Duration"
        value={duration}
        onChange={(e) => onDurationChange(e.target.value)}
      />
      {error && <span role="alert">{error}</span>}
    </div>
  ),
}));

vi.mock("../../ui/Stepper", () => ({
  Stepper: ({ steps, currentStep }: { steps: string[]; currentStep: number }) => (
    <nav aria-label="Progress">
      {steps.map((s, i) => (
        <span key={s} aria-current={i + 1 === currentStep ? "step" : undefined}>
          {s}
        </span>
      ))}
    </nav>
  ),
}));

vi.mock("../../ui/Button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    loading,
    variant,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    loading?: boolean;
    variant?: string;
  }) => (
    <button onClick={onClick} disabled={disabled || loading} data-variant={variant}>
      {loading ? <span aria-label="Loading" /> : null}
      {children}
    </button>
  ),
}));

import { StreamCreationWizard } from "../StreamCreationWizard";
import { useRouter } from "next/navigation";
import { getApiBaseUrl } from "@/lib/api/_shared";

// Valid Stellar Ed25519 public key: G + 55 base32 chars (A-Z, 2-7)
const VALID_KEY = "GABCDEFGHJKLMNPQRSTUVWXYZ234567ABCDEFGHJKLMNPQRSTUVWXYZ2";

function renderWizard(overrides: Partial<React.ComponentProps<typeof StreamCreationWizard>> = {}) {
  const onClose = vi.fn();
  const onSubmit = vi.fn().mockResolvedValue({ txHash: "abc123hash" });
  const push = vi.fn();
  (useRouter as ReturnType<typeof vi.fn>).mockReturnValue({ push });

  const result = render(
    <StreamCreationWizard
      onClose={onClose}
      onSubmit={onSubmit}
      walletPublicKey={VALID_KEY}
      {...overrides}
    />
  );

  return { onClose, onSubmit, push, ...result };
}

function clickNext() {
  fireEvent.click(screen.getByText("Next"));
}

function clickBack() {
  fireEvent.click(screen.getByText("Back"));
}

function clickCreate() {
  fireEvent.click(screen.getByText("Create Stream"));
}

function clickCancel() {
  fireEvent.click(screen.getByText("Cancel"));
}

function advanceToStep5() {
  clickNext(); // 1→2
  fireEvent.change(screen.getByLabelText("Recipient Address"), { target: { value: VALID_KEY } });
  clickNext(); // 2→3
  clickNext(); // 3→4 (token step, USDC is default)
  clickNext(); // 4→5 (amount step, 5000 is default)
}

describe("StreamCreationWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getApiBaseUrl).mockReturnValue("http://localhost:3001");
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  it("renders the wizard dialog with title and template step", () => {
    renderWizard();
    expect(screen.getByText("Create Payment Stream")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.getByText("Next")).toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", () => {
    const { onClose } = renderWizard();
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Cancel is clicked", () => {
    const { onClose } = renderWizard();
    clickCancel();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when clicking the backdrop", () => {
    const { onClose } = renderWizard();
    const backdrop = screen.getByRole("dialog");
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Step navigation ────────────────────────────────────────────────────────

  it("starts on step 1 (Template)", () => {
    renderWizard();
    expect(screen.getByText("Step 1 of 5")).toBeInTheDocument();
    expect(screen.getByText("Template", { selector: "[aria-current='step']" })).toBeInTheDocument();
  });

  it("advances to step 2 when Next is clicked on Template step", () => {
    renderWizard();
    clickNext();
    expect(screen.getByText("Step 2 of 5")).toBeInTheDocument();
    expect(screen.getByTestId("recipient-step")).toBeInTheDocument();
  });

  it("goes back to step 1 when Back is clicked on step 2", () => {
    renderWizard();
    clickNext();
    clickBack();
    expect(screen.getByText("Step 1 of 5")).toBeInTheDocument();
  });

  it("does not go back from step 1", () => {
    renderWizard();
    expect(screen.queryByText("Back")).not.toBeInTheDocument();
  });

  // ── Step-by-step validation gating ────────────────────────────────────────

  it("shows validation error for empty recipient on step 2", () => {
    renderWizard();
    clickNext(); // go to step 2
    fireEvent.change(screen.getByLabelText("Recipient Address"), { target: { value: "" } });
    clickNext(); // try to advance
    expect(screen.getByRole("alert")).toHaveTextContent("Recipient address is required");
    expect(screen.getByText("Step 2 of 5")).toBeInTheDocument();
  });

  it("shows validation error for invalid Stellar public key", () => {
    renderWizard();
    clickNext();
    fireEvent.change(screen.getByLabelText("Recipient Address"), { target: { value: "not-a-key" } });
    clickNext();
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid Stellar public key format");
  });

  it("advances past step 2 with a valid recipient", () => {
    renderWizard();
    clickNext();
    fireEvent.change(screen.getByLabelText("Recipient Address"), { target: { value: VALID_KEY } });
    clickNext();
    expect(screen.getByText("Step 3 of 5")).toBeInTheDocument();
  });

  it("advances past step 4 with a valid amount", () => {
    renderWizard();
    advanceToStep5();
    expect(screen.getByText("Step 5 of 5")).toBeInTheDocument();
  });

  // ── Submit flow ────────────────────────────────────────────────────────────

  it("does not submit when on an invalid step", () => {
    const { onSubmit } = renderWizard();
    advanceToStep5();
    // Clear the duration to make step 5 invalid
    fireEvent.change(screen.getByLabelText("Duration"), { target: { value: "" } });
    clickCreate();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onSubmit with form data", async () => {
    const { onSubmit } = renderWizard();
    advanceToStep5();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ streamId: "123" }] }))
    ));

    await act(async () => {
      clickCreate();
    });

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: VALID_KEY,
        token: "USDC",
        amount: "5000",
        duration: "1",
        durationUnit: "months",
      })
    );
  });

  it("redirects to stream page after polling finds the stream", async () => {
    const { push } = renderWizard();
    advanceToStep5();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ streamId: "123" }] }))
    ));

    await act(async () => {
      clickCreate();
    });

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/streams/123");
    });
  });

  it("submits and shows polling UI on valid form", async () => {
    const { onSubmit } = renderWizard();
    advanceToStep5();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ streamId: "123" }] }))
    ));

    await act(async () => {
      clickCreate();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Waiting for confirmation...")).toBeInTheDocument();
  });

  // ── Polling behavior ──────────────────────────────────────────────────────

  it("shows the three-step confirmation UI during polling", async () => {
    renderWizard();
    advanceToStep5();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ streamId: "123" }] }))
    ));

    await act(async () => {
      clickCreate();
    });

    expect(screen.getByText("Sign Transaction")).toBeInTheDocument();
    expect(screen.getByText("Network Confirmation")).toBeInTheDocument();
    expect(screen.getByText("Indexer Synchronization")).toBeInTheDocument();
  });

  it("hides navigation buttons during polling", async () => {
    renderWizard();
    advanceToStep5();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ streamId: "123" }] }))
    ));

    await act(async () => {
      clickCreate();
    });

    expect(screen.queryByText("Back")).not.toBeInTheDocument();
    expect(screen.queryByText("Cancel")).not.toBeInTheDocument();
    expect(screen.queryByText("Create Stream")).not.toBeInTheDocument();
  });

  it("handles flat array response from indexer", async () => {
    const { push } = renderWizard();
    advanceToStep5();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ streamId: "789" }]))
    ));

    await act(async () => {
      clickCreate();
    });

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/streams/789");
    });
  });

  it("handles nested data response from indexer", async () => {
    const { push } = renderWizard();
    advanceToStep5();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ streamId: "999" }] }))
    ));

    await act(async () => {
      clickCreate();
    });

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/streams/999");
    });
  });

  it("retries on fetch error during polling", async () => {
    vi.useFakeTimers();
    const { push } = renderWizard();
    advanceToStep5();

    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ streamId: "retry-ok" }] })));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      clickCreate();
    });

    // First poll fails, then startPolling waits POLL_INTERVAL (2s) before retrying
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenCalledWith("/streams/retry-ok");
    vi.useRealTimers();
  });

  // ── Timeout handling ──────────────────────────────────────────────────────

  it("shows timeout error after polling timeout (30s)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }))
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWizard();
    advanceToStep5();

    await act(async () => {
      clickCreate();
    });

    // Advance past the 30s timeout
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });

    expect(screen.getByText("Confirmation Timeout")).toBeInTheDocument();
    expect(screen.getByText(/couldn't detect your stream yet/)).toBeInTheDocument();

    vi.useRealTimers();
  });

  it("shows txHash in the timeout error UI", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }))
    ));

    renderWizard();
    advanceToStep5();

    await act(async () => {
      clickCreate();
    });

    await act(async () => {
      vi.advanceTimersByTime(30000);
    });

    expect(screen.getByText("abc123hash")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows a link to Stellar Expert in timeout error UI", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }))
    ));

    renderWizard();
    advanceToStep5();

    await act(async () => {
      clickCreate();
    });

    await act(async () => {
      vi.advanceTimersByTime(30000);
    });

    const link = screen.getByText("View on Stellar Expert");
    expect(link).toBeInTheDocument();
    expect(link.closest("a")).toHaveAttribute(
      "href",
      "https://stellar.expert/explorer/testnet/tx/abc123hash"
    );
    vi.useRealTimers();
  });

  it("shows Go to Dashboard button on timeout", async () => {
    vi.useFakeTimers();
    const { onClose } = renderWizard();
    advanceToStep5();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }))
    ));

    await act(async () => {
      clickCreate();
    });

    await act(async () => {
      vi.advanceTimersByTime(30000);
    });

    fireEvent.click(screen.getByText("Go to Dashboard"));
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // ── txHash propagation (regression) ───────────────────────────────────────

  it("surfaces txHash from onSubmit in the polling/timeout UI", async () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn().mockResolvedValue({ txHash: "specificTxHash123" });
    const push = vi.fn();
    (useRouter as ReturnType<typeof vi.fn>).mockReturnValue({ push });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }))
    ));

    render(
      <StreamCreationWizard
        onClose={vi.fn()}
        onSubmit={onSubmit}
        walletPublicKey={VALID_KEY}
      />
    );

    advanceToStep5();

    await act(async () => {
      clickCreate();
    });

    await act(async () => {
      vi.advanceTimersByTime(30000);
    });

    expect(screen.getByText("specificTxHash123")).toBeInTheDocument();
    expect(
      screen.getByText("View on Stellar Expert").closest("a")
    ).toHaveAttribute("href", expect.stringContaining("specificTxHash123"));
    vi.useRealTimers();
  });

  it("txHash is NOT undefined when onSubmit resolves with a hash", async () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn().mockResolvedValue({ txHash: "def456" });
    const push = vi.fn();
    (useRouter as ReturnType<typeof vi.fn>).mockReturnValue({ push });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }))
    ));

    render(
      <StreamCreationWizard
        onClose={vi.fn()}
        onSubmit={onSubmit}
        walletPublicKey={VALID_KEY}
      />
    );

    advanceToStep5();

    await act(async () => {
      clickCreate();
    });

    await act(async () => {
      vi.advanceTimersByTime(30000);
    });

    const codeElements = screen.getAllByText("def456");
    expect(codeElements.length).toBeGreaterThan(0);
    expect(screen.queryByText("undefined")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it("catches onSubmit errors and stops submitting", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("wallet rejected"));
    const push = vi.fn();
    (useRouter as ReturnType<typeof vi.fn>).mockReturnValue({ push });

    render(
      <StreamCreationWizard
        onClose={vi.fn()}
        onSubmit={onSubmit}
        walletPublicKey={VALID_KEY}
      />
    );

    advanceToStep5();

    await act(async () => {
      clickCreate();
    });

    // Should not show polling UI since the error was caught
    expect(screen.queryByText("Waiting for confirmation...")).not.toBeInTheDocument();
    // Should still be on step 5
    expect(screen.getByText("Step 5 of 5")).toBeInTheDocument();
  });

  // ── Progress indicator ────────────────────────────────────────────────────

  it("displays correct percentage during steps", () => {
    renderWizard();
    expect(screen.getByText("20% complete")).toBeInTheDocument();

    clickNext();
    expect(screen.getByText("40% complete")).toBeInTheDocument();
  });

  // ── Description tag badge ──────────────────────────────────────────────────

  it("shows description tag badge when a tag is set", () => {
    renderWizard();
    expect(screen.getByText("Tag: salary")).toBeInTheDocument();
  });
});
