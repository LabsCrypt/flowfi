import { describe, it, expect } from "vitest";
import { buildCalendarDays, getStreamsForDate, type Stream } from "./CalendarView";

const USER = "GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7";

function stream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "1",
    streamId: 1,
    sender: USER,
    recipient: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    tokenSymbol: "USDC",
    ratePerSecond: 0.001,
    depositedAmount: "1000",
    withdrawnAmount: "0",
    startTime: Date.UTC(2026, 0, 10) / 1000,
    endTime: Date.UTC(2026, 0, 20) / 1000,
    isActive: true,
    status: "active",
    ...overrides,
  };
}

describe("buildCalendarDays", () => {
  it("always renders a 6x7 grid padded with neighbouring months", () => {
    // January 2026 starts on a Thursday, so the grid opens on 28 December 2025.
    const days = buildCalendarDays(new Date(2026, 0, 15), []);

    expect(days).toHaveLength(42);
    expect(days[0]!.date.getFullYear()).toBe(2025);
    expect(days[0]!.date.getMonth()).toBe(11);
    expect(days[0]!.date.getDate()).toBe(28);
    expect(days[0]!.isCurrentMonth).toBe(false);

    expect(days[4]!.date.getMonth()).toBe(0);
    expect(days[4]!.date.getDate()).toBe(1);
    expect(days[4]!.isCurrentMonth).toBe(true);
  });

  it("keeps the grid a fixed size for a short February", () => {
    const days = buildCalendarDays(new Date(2026, 1, 10), []);

    expect(days).toHaveLength(42);
    const currentMonthDays = days.filter((day) => day.isCurrentMonth);
    expect(currentMonthDays).toHaveLength(28);
    expect(currentMonthDays[0]!.date.getDate()).toBe(1);
    expect(currentMonthDays[27]!.date.getDate()).toBe(28);
  });

  it("flags today only once", () => {
    const now = new Date();
    const days = buildCalendarDays(now, []);

    expect(days.filter((day) => day.isToday)).toHaveLength(1);
  });

  it("attaches start and active events to the right days", () => {
    const days = buildCalendarDays(new Date(2026, 0, 15), [stream()]);
    const byDay = (date: number) => days.find((day) => day.isCurrentMonth && day.date.getDate() === date)!;

    expect(byDay(10).streams.some((event) => event.type === "start")).toBe(true);
    expect(byDay(15).streams.some((event) => event.type === "active")).toBe(true);
    expect(byDay(20).streams.some((event) => event.type === "end")).toBe(true);
    expect(byDay(21).streams).toHaveLength(0);
    expect(byDay(9).streams).toHaveLength(0);
  });
});

describe("getStreamsForDate", () => {
  it("reports an open-ended stream as active after its start", () => {
    const day = new Date(2027, 5, 1);
    const events = getStreamsForDate(day, [stream({ endTime: undefined })]);

    expect(events.map((event) => event.type)).toContain("active");
  });

  it("ignores streams that ended before the day begins", () => {
    const day = new Date(2026, 5, 1);
    const events = getStreamsForDate(day, [stream()]);

    expect(events).toHaveLength(0);
  });
});
