import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const useNetworkMock = vi.fn();

vi.mock("@/context/NetworkContext", () => ({
  useNetwork: () => useNetworkMock(),
}));

import { NetworkSelector } from "./NetworkSelector";

describe("NetworkSelector", () => {
  const setNetworkId = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useNetworkMock.mockReturnValue({ networkId: "testnet", setNetworkId });
  });

  it("shows the active Testnet badge and available Stellar networks", () => {
    const { container } = render(<NetworkSelector />);
    const selector = screen.getByRole("combobox", {
      name: "Active Stellar network",
    });
    const badge = container.querySelector("label span");

    expect(selector).toHaveValue("testnet");
    expect(badge).toHaveClass("bg-orange-400");
    expect(screen.getByRole("option", { name: "Testnet" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Mainnet" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Futurenet" })).toBeInTheDocument();
  });

  it("uses the active network's badge color", () => {
    useNetworkMock.mockReturnValue({ networkId: "mainnet", setNetworkId });
    const { container } = render(<NetworkSelector />);

    expect(container.querySelector("label span")).toHaveClass("bg-emerald-400");
  });

  it("sets the selected network", async () => {
    const user = userEvent.setup();
    render(<NetworkSelector />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Active Stellar network" }),
      "mainnet",
    );

    expect(setNetworkId).toHaveBeenCalledWith("mainnet");
  });

  it("keeps the native selector keyboard accessible", async () => {
    const user = userEvent.setup();
    render(<NetworkSelector />);
    const selector = screen.getByRole("combobox", {
      name: "Active Stellar network",
    });
    const handleKeyDown = vi.fn();
    selector.addEventListener("keydown", handleKeyDown);

    await user.tab();
    expect(selector).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(selector).toHaveFocus();
    expect(handleKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: "ArrowDown" }));
    expect(handleKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: "Enter" }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Testnet",
      "Futurenet",
      "Mainnet",
      "Sandbox",
    ]);
  });
});
