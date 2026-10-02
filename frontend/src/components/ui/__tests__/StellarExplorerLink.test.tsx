import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { StellarExplorerLink } from "../StellarExplorerLink";

// The component reads the active network from NetworkContext. A mutable
// networkId lets each test pick the network it asserts against without
// re-mocking the module per case.
const networkState = vi.hoisted(() => ({ networkId: "testnet" }));

vi.mock("@/context/NetworkContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/context/NetworkContext")>();
  return {
    ...actual,
    useNetwork: () => ({ networkId: networkState.networkId }),
  };
});

describe("StellarExplorerLink", () => {
  beforeEach(() => {
    networkState.networkId = "testnet";
  });

  it("generates correct Testnet URL", () => {
    render(<StellarExplorerLink type="tx" id="abc123hash" />);

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      "https://stellar.expert/explorer/testnet/tx/abc123hash",
    );
  });

  it("generates correct Mainnet URL when network is mainnet", () => {
    networkState.networkId = "mainnet";

    render(<StellarExplorerLink type="account" id="GABC123" />);

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      "https://stellar.expert/explorer/mainnet/account/GABC123",
    );
  });

  it("truncates long hashes by default", () => {
    render(<StellarExplorerLink type="tx" id="abcdefghijklmnopqrstuvwxyz123456" />);

    expect(screen.getByText(/abcdef\.\.\.123456/)).toBeInTheDocument();
  });

  it("shows full hash when truncate is false", () => {
    const fullHash = "abcdefghijklmnopqrstuvwxyz123456";
    render(<StellarExplorerLink type="tx" id={fullHash} truncate={false} />);

    expect(screen.getByText(fullHash)).toBeInTheDocument();
  });
});