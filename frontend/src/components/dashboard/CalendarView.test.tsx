import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CalendarView } from "./CalendarView";

describe("CalendarView", () => {
  it("disables the Today button when already viewing the current month and enables it when navigating away", () => {
    render(<CalendarView streams={[]} />);

    const todayButton = screen.getByRole("button", { name: "Today" });
    expect(todayButton).toBeDisabled();

    const nextMonthButton = screen.getByRole("button", { name: "Next month" });
    fireEvent.click(nextMonthButton);

    expect(todayButton).not.toBeDisabled();
  });

  it("resets the displayed month and year to the current system date when clicking Today", () => {
    render(<CalendarView streams={[]} />);

    const now = new Date();
    const expectedLabel = now.toLocaleString("default", {
      month: "long",
      year: "numeric",
    });

    const monthHeading = screen.getByTestId("calendar-current-month");
    expect(monthHeading).toHaveTextContent(expectedLabel);

    const nextMonthButton = screen.getByRole("button", { name: "Next month" });
    fireEvent.click(nextMonthButton);
    fireEvent.click(nextMonthButton);
    fireEvent.click(nextMonthButton);

    const todayButton = screen.getByRole("button", { name: "Today" });
    expect(todayButton).not.toBeDisabled();

    fireEvent.click(todayButton);

    expect(monthHeading).toHaveTextContent(expectedLabel);
    expect(todayButton).toBeDisabled();
  });

  it("highlights the current day cell with an accent border ring and a Today pill badge", () => {
    render(<CalendarView streams={[]} />);

    const todayCell = screen.getByTestId("calendar-today-cell");
    expect(todayCell).toBeInTheDocument();
    expect(todayCell).toHaveAttribute("aria-current", "date");
    expect(todayCell.className).toContain("ring-2");
    expect(todayCell.className).toContain("ring-accent");

    const todayBadge = screen.getByTestId("calendar-today-badge");
    expect(todayBadge).toBeInTheDocument();
    expect(todayBadge).toHaveTextContent("Today");
  });

  it("navigates to previous month and returns to current month via Today button", () => {
    render(<CalendarView streams={[]} />);

    const now = new Date();
    const expectedLabel = now.toLocaleString("default", {
      month: "long",
      year: "numeric",
    });

    const prevMonthButton = screen.getByRole("button", {
      name: "Previous month",
    });
    fireEvent.click(prevMonthButton);

    const todayButton = screen.getByRole("button", { name: "Today" });
    expect(todayButton).not.toBeDisabled();

    fireEvent.click(todayButton);
    expect(screen.getByTestId("calendar-current-month")).toHaveTextContent(
      expectedLabel,
    );
    expect(todayButton).toBeDisabled();
  });
});
