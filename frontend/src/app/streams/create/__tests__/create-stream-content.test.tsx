import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";

// ─── Session storage mock ───────────────────────────────────────────────────
const sessionStorageMock = (() => {
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
    get length() {
      return Object.keys(store).length;
    },
  };
})();

vi.stubGlobal("sessionStorage", sessionStorageMock);
if (typeof window !== "undefined") {
  Object.defineProperty(window, "sessionStorage", {
    value: sessionStorageMock,
    configurable: true,
    writable: true,
  });
}

const searchParamsMock = { get: vi.fn() };
const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => searchParamsMock,
}));

vi.mock("react-hot-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

vi.mock("@/context/wallet-context", () => ({
  useWallet: () => ({ status: "disconnected", session: null }),
}));

vi.mock("@/lib/soroban", () => ({
  createStream: vi.fn(),
  toBaseUnits: vi.fn(),
  toDurationSeconds: vi.fn(),
  getTokenAddress: vi.fn(),
  toSorobanErrorMessage: vi.fn(),
  TOKEN_ADDRESSES: { XLM: "xlm-address", USDC: "usdc-address" },
}));

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import CreateStreamContent from "../create-stream-content";

function getRecipientInput() {
  return screen.getByLabelText(/recipient/i) as HTMLInputElement;
}

function getAmountInput() {
  return screen.getByLabelText(/total amount/i) as HTMLInputElement;
}

function getDurationInput() {
  return screen.getByLabelText(/duration/i) as HTMLInputElement;
}

describe("CreateStreamContent sessionStorage draft persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorageMock.clear();
    searchParamsMock.get.mockReturnValue(null);
  });

  it("saves form data to sessionStorage when fields change", async () => {
    render(<CreateStreamContent />);

    const recipientInput = getRecipientInput();
    const amountInput = getAmountInput();

    await act(async () => {
      fireEvent.change(recipientInput, {
        target: { value: "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7" },
      });
    });

    await act(async () => {
      fireEvent.change(amountInput, { target: { value: "100" } });
    });

    // Wait for debounced save
    await waitFor(
      () => {
        expect(sessionStorageMock.setItem).toHaveBeenCalled();
      },
      { timeout: 1000 }
    );

    const lastCallArgs =
      sessionStorageMock.setItem.mock.calls[
        sessionStorageMock.setItem.mock.calls.length - 1
      ]!;
    expect(lastCallArgs[0]).toBe("flowfi.create-stream.draft.v1");

    const savedData = JSON.parse(lastCallArgs[1]);
    expect(savedData.recipient).toBe(
      "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7"
    );
    expect(savedData.amount).toBe("100");
    expect(savedData.token).toBe("XLM");
    expect(typeof savedData.savedAt).toBe("number");
  });

  it("does not write an empty draft for a pristine form", async () => {
    sessionStorageMock.getItem.mockReturnValue(null);

    render(<CreateStreamContent />);

    // Wait well past the debounce window
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(sessionStorageMock.setItem).not.toHaveBeenCalled();
  });

  it("ignores an empty draft on load", () => {
    sessionStorageMock.getItem.mockReturnValue(
      JSON.stringify({
        recipient: "",
        token: "XLM",
        amount: "",
        duration: "30",
        savedAt: Date.now() - 60000,
      })
    );

    render(<CreateStreamContent />);

    // No bogus "resumed draft" banner over a blank form
    expect(
      screen.queryByText(/resumed a saved draft/i)
    ).not.toBeInTheDocument();
    expect(getRecipientInput().value).toBe("");
    expect(getAmountInput().value).toBe("");
    expect(getDurationInput().value).toBe("30");
  });

  it("restores draft from sessionStorage on mount", async () => {
    const draft = {
      recipient: "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7",
      token: "USDC",
      amount: "250",
      duration: "60",
      savedAt: Date.now() - 30000,
    };
    sessionStorageMock.getItem.mockReturnValue(JSON.stringify(draft));

    render(<CreateStreamContent />);

    await waitFor(() => {
      expect(getRecipientInput().value).toBe(
        "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7"
      );
    });

    expect(getAmountInput().value).toBe("250");
    expect(getDurationInput().value).toBe("60");

    // Should show the resume draft banner
    expect(screen.getByText(/resumed a saved draft/i)).toBeInTheDocument();
  });

  it("shows resume draft banner when draft is restored", async () => {
    const draft = {
      recipient: "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7",
      token: "XLM",
      amount: "50",
      duration: "30",
      savedAt: Date.now() - 60000,
    };
    sessionStorageMock.getItem.mockReturnValue(JSON.stringify(draft));

    render(<CreateStreamContent />);

    await waitFor(() => {
      expect(screen.getByText(/resumed a saved draft/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/discard draft/i)).toBeInTheDocument();
  });

  it("clears form and removes draft when 'Discard Draft' is clicked", async () => {
    const draft = {
      recipient: "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7",
      token: "XLM",
      amount: "50",
      duration: "30",
      savedAt: Date.now() - 60000,
    };
    sessionStorageMock.getItem.mockReturnValue(JSON.stringify(draft));

    render(<CreateStreamContent />);

    await waitFor(() => {
      expect(screen.getByText(/discard draft/i)).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText(/discard draft/i));
    });

    expect(sessionStorageMock.removeItem).toHaveBeenCalledWith(
      "flowfi.create-stream.draft.v1"
    );

    // The banner should be gone
    expect(screen.queryByText(/resumed a saved draft/i)).not.toBeInTheDocument();
  });

  it("does not prefill from query params when a draft is restored", async () => {
    const draft = {
      recipient: "GDRAFT_RESTORED_ADDRESS_12345678901234567890123456789012345678901",
      token: "XLM",
      amount: "10",
      duration: "30",
      savedAt: Date.now() - 30000,
    };
    sessionStorageMock.getItem.mockReturnValue(JSON.stringify(draft));
    searchParamsMock.get.mockImplementation(
      (key: string) =>
        key === "recipient"
          ? "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7"
          : null
    );

    render(<CreateStreamContent />);

    await waitFor(() => {
      expect(getRecipientInput().value).toBe(
        "GDRAFT_RESTORED_ADDRESS_12345678901234567890123456789012345678901"
      );
    });

    // The draft value should take precedence, not the query param
    expect(getRecipientInput().value).not.toBe(
      "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7"
    );
  });

  it("does not show draft banner if no draft exists", () => {
    sessionStorageMock.getItem.mockReturnValue(null);

    render(<CreateStreamContent />);

    expect(screen.queryByText(/resumed a saved draft/i)).not.toBeInTheDocument();
  });

  it("shows default empty form when no draft exists", () => {
    sessionStorageMock.getItem.mockReturnValue(null);

    render(<CreateStreamContent />);

    expect(getRecipientInput().value).toBe("");
    expect(getAmountInput().value).toBe("");
    expect(getDurationInput().value).toBe("30");
  });
});
