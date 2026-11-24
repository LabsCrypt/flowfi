import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DisconnectConfirmModal } from "./DisconnectConfirmModal";

describe("DisconnectConfirmModal", () => {
  it("confirms wallet disconnection when Disconnect is selected", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();

    render(
      <DisconnectConfirmModal
        onConfirm={onConfirm}
        onClose={onClose}
        walletAddress="GTESTWALLETADDRESS"
      />,
    );

    expect(screen.getByText("GTESTWALLETADDRESS")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes without disconnecting when Cancel is selected", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();

    render(<DisconnectConfirmModal onConfirm={onConfirm} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("closes without disconnecting when Escape is pressed", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();

    render(<DisconnectConfirmModal onConfirm={onConfirm} onClose={onClose} />);
    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
