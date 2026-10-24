import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const mockUseTokenPrice = vi.fn();

vi.mock("@/hooks/useTokenPrice", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useTokenPrice")>(
    "@/hooks/useTokenPrice",
  );
  return {
    ...actual,
    useTokenPrice: (...args: unknown[]) => mockUseTokenPrice(...args),
  };
});

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ displayCurrency: "USD" }),
}));

import { FiatEquivalent } from "../FiatEquivalent";

describe("FiatEquivalent stale price warning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders fresh quotes (< 5 minutes old) without a warning indicator", () => {
    const freshTimestamp = Date.now() - 2 * 60 * 1000; // 2 minutes ago
    mockUseTokenPrice.mockReturnValue({
      data: {
        tokenSymbol: "XLM",
        priceUSD: 0.12,
        priceEUR: 0.11,
        priceGBP: 0.09,
        timestamp: freshTimestamp,
      },
      isLoading: false,
      lastUpdatedAt: freshTimestamp,
    });

    render(<FiatEquivalent tokenSymbol="XLM" amount="1000" />);

    expect(screen.getByText(/1,000\.00 XLM/)).toBeInTheDocument();
    expect(screen.getByText(/\(\$120\.00 USD\)|≈ \$120\.00 USD/)).toBeInTheDocument();
    expect(screen.queryByTestId("stale-price-warning")).not.toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("displays an amber info indicator and accessible tooltip when quote is > 5 minutes old", () => {
    const staleTimestamp = Date.now() - 8 * 60 * 1000; // 8 minutes ago
    mockUseTokenPrice.mockReturnValue({
      data: {
        tokenSymbol: "XLM",
        priceUSD: 0.12,
        priceEUR: 0.11,
        priceGBP: 0.09,
        timestamp: staleTimestamp,
      },
      isLoading: false,
      lastUpdatedAt: staleTimestamp,
    });

    render(<FiatEquivalent tokenSymbol="XLM" amount="1000" />);

    const warning = screen.getByTestId("stale-price-warning");
    expect(warning).toBeInTheDocument();
    expect(warning).toHaveAttribute(
      "title",
      "Price estimate last updated 8 minutes ago",
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Price estimate last updated 8 minutes ago",
    );
  });

  it("gracefully handles null or missing price data without crashing", () => {
    mockUseTokenPrice.mockReturnValue({
      data: null,
      isLoading: false,
      lastUpdatedAt: null,
    });

    const { container, rerender } = render(
      <FiatEquivalent tokenSymbol="XLM" amount="1000" />,
    );
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
    expect(screen.queryByTestId("stale-price-warning")).not.toBeInTheDocument();

    // Missing timestamp / lastUpdatedAt on returned object should also render safely without warning
    mockUseTokenPrice.mockReturnValue({
      data: {
        tokenSymbol: "USDC",
        priceUSD: 1.0,
        priceEUR: 0.92,
        priceGBP: 0.79,
      },
      isLoading: false,
      lastUpdatedAt: null,
    });

    rerender(<FiatEquivalent tokenSymbol="USDC" amount="500" />);
    expect(screen.getByText(/500\.00 USDC/)).toBeInTheDocument();
    expect(screen.queryByTestId("stale-price-warning")).not.toBeInTheDocument();
  });
});