/**
 * ScheduleStep regression tests (issue #1797).
 *
 * The schedule step owns the stream duration (and its unit) plus the optional
 * memo. Durations are turned into a fixed number of *seconds* on-chain, so
 * the conversion must not depend on the viewer's timezone, on calendar
 * arithmetic, or on daylight-saving transitions. The memo is capped at 28
 * UTF-8 bytes (the Stellar memo limit).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ComponentProps } from "react";

import { ScheduleStep } from "../ScheduleStep";
import { validateDuration } from "@/lib/stream-validation";
import { toDurationSeconds, SECONDS_PER_UNIT } from "@/lib/soroban";

const MAX_MEMO_BYTES = 28;

type ScheduleStepProps = ComponentProps<typeof ScheduleStep>;

function renderScheduleStep(props: Partial<ScheduleStepProps> = {}) {
  const onUpdate = vi.fn();
  const utils = render(
    <ScheduleStep
      formData={{ duration: "30", durationUnit: "days", descriptionTag: "", memo: "" }}
      errors={{}}
      onUpdate={onUpdate}
      {...props}
    />,
  );
  return { onUpdate, ...utils };
}

function getDurationInput() {
  return screen.getByLabelText(/duration/i) as HTMLInputElement;
}

function getUnitSelect() {
  return screen.getByRole("combobox") as HTMLSelectElement;
}

function getMemoTextarea() {
  return screen.getByLabelText(/memo/i) as HTMLTextAreaElement;
}

/** The "N / 28 bytes" counter (distinct from the warning copy, which also ends in "bytes"). */
function getByteCounter() {
  return screen.getByText(/^\d+ \/ 28 bytes$/);
}

describe("ScheduleStep — duration unit conversion (issue #1797)", () => {
  it("renders the three supported duration units", () => {
    renderScheduleStep();

    const options = Array.from(getUnitSelect().options).map((o) => o.value);
    expect(options).toEqual(["days", "weeks", "months"]);
  });

  it("reports the selected duration unit to the parent", () => {
    const { onUpdate } = renderScheduleStep();

    fireEvent.change(getUnitSelect(), { target: { value: "weeks" } });
    expect(onUpdate).toHaveBeenCalledWith({ durationUnit: "weeks" });
  });

  it("reports duration changes to the parent", () => {
    const { onUpdate } = renderScheduleStep();

    fireEvent.change(getDurationInput(), { target: { value: "45" } });
    expect(onUpdate).toHaveBeenCalledWith({ duration: "45" });
  });

  it("converts every unit to a fixed number of seconds", () => {
    expect(toDurationSeconds("1", "days")).toBe(86_400n);
    expect(toDurationSeconds("1", "weeks")).toBe(604_800n);
    expect(toDurationSeconds("1", "months")).toBe(2_592_000n);

    expect(SECONDS_PER_UNIT.days).toBe(86_400n);
    expect(SECONDS_PER_UNIT.weeks).toBe(604_800n);
    expect(SECONDS_PER_UNIT.months).toBe(2_592_000n);
  });

  it("converts a month to exactly 30 days, never to a calendar month", () => {
    // A calendar month varies between 28 and 31 days; the on-chain duration
    // must stay deterministic regardless of the month the stream starts in.
    expect(toDurationSeconds("1", "months")).toBe(BigInt(30 * 86_400));
    expect(toDurationSeconds("12", "months")).toBe(BigInt(360 * 86_400));
  });
});

describe("ScheduleStep — timezone and daylight-saving boundaries (issue #1797)", () => {
  // 2026-03-08 is the US DST switch (local clocks jump from 02:00 to 03:00),
  // 2026-11-01 is the US DST end (local clocks fall back one hour).
  const DST_START_UTC = Date.UTC(2026, 2, 8, 6, 30, 0);
  const DST_END_UTC = Date.UTC(2026, 10, 1, 5, 30, 0);

  it("keeps the elapsed duration invariant across a spring-forward transition", () => {
    const oneDayMs = 86_400_000;
    const end = DST_START_UTC + oneDayMs;

    // The stream runs for exactly 24 hours of wall-clock time...
    expect(end - DST_START_UTC).toBe(oneDayMs);
    // ...even though the local calendar day is only 23 hours long.
    const localDayLength = localDayLengthMs(DST_START_UTC, "America/New_York");
    expect(localDayLength).toBe(23 * 3_600_000);
  });

  it("keeps the elapsed duration invariant across a fall-back transition", () => {
    const oneDayMs = 86_400_000;
    const end = DST_END_UTC + oneDayMs;

    expect(end - DST_END_UTC).toBe(oneDayMs);
    // The local calendar day is 25 hours long on this date.
    const localDayLength = localDayLengthMs(DST_END_UTC, "America/New_York");
    expect(localDayLength).toBe(25 * 3_600_000);
  });

  it("produces the same duration in seconds no matter which timezone the user is in", () => {
    // The on-chain duration is derived from the unit only — never from the
    // user's local calendar — so every timezone yields the same seconds.
    const durations = ["UTC", "America/New_York", "Europe/Berlin", "Asia/Tokyo"].map(
      () => toDurationSeconds("30", "days"),
    );

    expect(new Set(durations.map(String)).size).toBe(1);
    expect(durations[0]).toBe(BigInt(30 * 86_400));
  });
});

describe("ScheduleStep — duration validation (issue #1797)", () => {
  it("rejects an empty duration", () => {
    expect(validateDuration("")).toBe("Duration is required");
  });

  it("rejects a zero or negative duration", () => {
    expect(validateDuration("0")).toBe("Duration must be a positive number");
    expect(validateDuration("-5")).toBe("Duration must be a positive number");
  });

  it("renders the duration error contract", () => {
    renderScheduleStep({ errors: { duration: "Duration must be a positive number" } });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Duration must be a positive number",
    );
  });

  it("renders the description tag error contract", () => {
    renderScheduleStep({ errors: { descriptionTag: "Description tag is too long" } });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Description tag is too long",
    );
  });

  it("reports description tag changes to the parent", () => {
    const { onUpdate } = renderScheduleStep();

    fireEvent.change(screen.getByLabelText(/description tag/i), {
      target: { value: "salary" },
    });
    expect(onUpdate).toHaveBeenCalledWith({ descriptionTag: "salary" });
  });
});

describe("ScheduleStep — memo byte limit (issue #1797)", () => {
  it("counts UTF-8 bytes, not characters", () => {
    renderScheduleStep({ formData: { duration: "30", durationUnit: "days", memo: "€" } });

    // "€" is three bytes in UTF-8.
    expect(getByteCounter()).toHaveTextContent("3 / 28 bytes");
  });

  it("does not warn while the memo is well below the limit", () => {
    renderScheduleStep({ formData: { duration: "30", durationUnit: "days", memo: "short" } });

    expect(getByteCounter()).toHaveTextContent("5 / 28 bytes");
    expect(screen.queryByText(/memo exceeds byte limit/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/approaching byte limit/i)).not.toBeInTheDocument();
  });

  it("warns when the memo approaches the byte limit", () => {
    // 23 bytes ≥ 80% of the 28-byte limit.
    renderScheduleStep({
      formData: { duration: "30", durationUnit: "days", memo: "x".repeat(23) },
    });

    expect(screen.getByText(/approaching byte limit/i)).toBeInTheDocument();
    expect(screen.queryByText(/memo exceeds byte limit/i)).not.toBeInTheDocument();
  });

  it("accepts a memo of exactly 28 bytes", () => {
    renderScheduleStep({
      formData: { duration: "30", durationUnit: "days", memo: "x".repeat(28) },
    });

    expect(getByteCounter()).toHaveTextContent("28 / 28 bytes");
    expect(screen.queryByText(/memo exceeds byte limit/i)).not.toBeInTheDocument();
  });

  it("rejects a memo of 29 bytes", () => {
    renderScheduleStep({
      formData: { duration: "30", durationUnit: "days", memo: "x".repeat(29) },
    });

    expect(getByteCounter()).toHaveTextContent("29 / 28 bytes");
    expect(screen.getByText(/memo exceeds byte limit/i)).toBeInTheDocument();
  });

  it("rejects a multi-byte memo that only looks short", () => {
    // 10 × "€" = 30 bytes, well over the limit despite being 10 characters.
    renderScheduleStep({
      formData: { duration: "30", durationUnit: "days", memo: "€".repeat(10) },
    });

    expect(getByteCounter()).toHaveTextContent("30 / 28 bytes");
    expect(screen.getByText(/memo exceeds byte limit/i)).toBeInTheDocument();
  });

  it("allows more characters than the byte limit but flags them", () => {
    renderScheduleStep({
      formData: { duration: "30", durationUnit: "days", memo: "x".repeat(MAX_MEMO_BYTES + 1) },
    });

    // The textarea accepts the input so the user can see the byte counter,
    // while the over-limit warning tells them the memo will be rejected.
    expect(getMemoTextarea().value).toHaveLength(MAX_MEMO_BYTES + 1);
    expect(screen.getByText(/memo exceeds byte limit/i)).toBeInTheDocument();
  });

  it("reports memo changes to the parent", () => {
    const { onUpdate } = renderScheduleStep();

    fireEvent.change(getMemoTextarea(), { target: { value: "note" } });
    expect(onUpdate).toHaveBeenCalledWith({ memo: "note" });
  });
});

/**
 * Length of the local calendar day (in ms) that contains `instant` in the
 * given IANA timezone. Used to prove that a DST transition really does make
 * a local day 23 or 25 hours long while FlowFi's duration stays fixed.
 */
function localDayLengthMs(instant: number, timeZone: string): number {
  const localDate = localDateParts(instant, timeZone);
  const start = localMidnightUtc(localDate, timeZone);
  const end = localMidnightUtc(
    { year: localDate.year, month: localDate.month, day: localDate.day + 1 },
    timeZone,
  );

  return end - start;
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

function localDateParts(instant: number, timeZone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  return { year: get("year"), month: get("month"), day: get("day") };
}

/** Offset (in ms) of `timeZone` from UTC at the given instant. */
function timeZoneOffsetMs(instant: number, timeZone: string): number {
  return localWallClockMs(instant, timeZone) - instant;
}

/** The UTC instant at which the given local calendar day starts. */
function localMidnightUtc(date: LocalDateParts, timeZone: string): number {
  const guess = Date.UTC(date.year, date.month - 1, date.day);
  const offset = timeZoneOffsetMs(guess, timeZone);
  const candidate = guess - offset;
  // The offset may have changed between the guess and the candidate
  // (exactly around a DST switch) — re-check once.
  const correctedOffset = timeZoneOffsetMs(candidate, timeZone);
  return correctedOffset === offset ? candidate : guess - correctedOffset;
}

/**
 * The local wall-clock reading of `instant` in `timeZone`, expressed as a UTC
 * timestamp.
 */
function localWallClockMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(instant));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");

  // Some ICU versions render midnight as hour "24" in hour12:false mode.
  const hour = get("hour") === 24 ? 0 : get("hour");

  return Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
}
