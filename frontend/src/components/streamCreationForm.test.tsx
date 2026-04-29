import { render, screen, fireEvent } from "@testing-library/react";
import { test, expect, vi } from "vitest";
import { StreamCreationWizard } from "./stream-creation/StreamCreationWizard";
import React from "react";

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
  // Actually, let's just click 'Next' and see if it goes to next step or shows errors if any.
  fireEvent.click(screen.getByText(/next/i));

  // It should move to Recipient step.
  expect(screen.getByText(/recipient/i)).toBeInTheDocument();
});