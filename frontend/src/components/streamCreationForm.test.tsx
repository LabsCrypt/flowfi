import { render, screen, fireEvent } from "@testing-library/react";
import { test, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn() })),
}));

import { StreamCreationWizard } from "./stream-creation/StreamCreationWizard";


test("StreamCreationWizard — validation errors shown", () => {
  const mockOnClose = vi.fn();
  const mockOnSubmit = vi.fn();

  render(
    <StreamCreationWizard
      onClose={mockOnClose}
      onSubmit={mockOnSubmit}
      walletPublicKey="GABC123"
    />
  );

  // The wizard starts at Template step. We need to go to Recipient step to test validation.
  // Click the Next button explicitly instead of matching incidental text.
  fireEvent.click(screen.getByRole('button', { name: /next/i }));

  // It should move to Recipient step.
  expect(screen.getByRole('heading', { name: /recipient address/i })).toBeInTheDocument();
});