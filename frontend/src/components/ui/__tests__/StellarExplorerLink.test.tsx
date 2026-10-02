import { render, screen } from "@testing-library/react";
import { StellarExplorerLink } from "../StellarExplorerLink";
import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockNetworkId } = vi.hoisted(() => ({ mockNetworkId: { current: "testnet" } }));
vi.mock("@/context/NetworkContext", () => ({
  useNetwork: () => ({ networkId: mockNetworkId.current }),
}));

describe("StellarExplorerLink", () => {
  beforeEach(() => { mockNetworkId.current = "testnet"; });
  it("generates correct Testnet URL", () => {
    render(
      <StellarExplorerLink type="tx" id="abc123hash" />
    );
    
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      "https://stellar.expert/explorer/testnet/tx/abc123hash"
    );
  });

  it("generates correct Mainnet URL when network is mainnet", () => {
    mockNetworkId.current = "mainnet";

    render(
      <StellarExplorerLink type="account" id="GABC123" />
    );
    
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute(
      "href",
      "https://stellar.expert/explorer/mainnet/account/GABC123"
    );
  });

  it("truncates long hashes by default", () => {
    render(
      <StellarExplorerLink type="tx" id="abcdefghijklmnopqrstuvwxyz123456" />
    );
    
    expect(screen.getByText(/abcdef\.\.\.123456/)).toBeInTheDocument();
  });

  it("shows full hash when truncate is false", () => {
    const fullHash = "abcdefghijklmnopqrstuvwxyz123456";
    render(
      <StellarExplorerLink type="tx" id={fullHash} truncate={false} />
    );
    
    expect(screen.getByText(fullHash)).toBeInTheDocument();
  });
});
