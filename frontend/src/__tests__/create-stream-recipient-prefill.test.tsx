import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const VALID_ADDRESS = "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7";

const searchParamsMock = { get: vi.fn() };
const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => searchParamsMock,
}));

vi.mock("react-hot-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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
  TOKEN_ADDRESSES: { XLM: "xlm-address" },
}));

import CreateStreamContent from "../app/streams/create/create-stream-content";

function getRecipientInput() {
  return screen.getByLabelText(/recipient/i) as HTMLInputElement;
}

describe("CreateStreamContent recipient prefill", () => {
  it("prefills the recipient field from a valid deep-linked query param", async () => {
    searchParamsMock.get.mockImplementation((key: string) => (key === "recipient" ? VALID_ADDRESS : null));

    render(<CreateStreamContent />);

    await waitFor(() => expect(getRecipientInput().value).toBe(VALID_ADDRESS));
  });

  it("ignores a malformed recipient query param and leaves the field empty", async () => {
    searchParamsMock.get.mockImplementation((key: string) => (key === "recipient" ? "not-a-stellar-address" : null));

    render(<CreateStreamContent />);

    await waitFor(() => expect(getRecipientInput()).toBeInTheDocument());
    expect(getRecipientInput().value).toBe("");
  });

  it("leaves the recipient field empty when no query param is present", () => {
    searchParamsMock.get.mockReturnValue(null);

    render(<CreateStreamContent />);

    expect(getRecipientInput().value).toBe("");
  });
});
