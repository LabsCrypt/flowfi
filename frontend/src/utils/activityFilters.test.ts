import { describe, it, expect } from "vitest";
import {
  filterActivityEvents,
  sortActivityEvents,
  type ActivityFilters,
} from "./activityFilters";
import type { BackendStreamEvent, StreamEventType } from "@/lib/api-types";

function makeEvent(
  overrides: Partial<BackendStreamEvent> = {},
): BackendStreamEvent {
  return {
    id: "evt",
    streamId: 1,
    eventType: "CREATED",
    amount: "1000000",
    transactionHash: "abc123",
    ledgerSequence: 1,
    timestamp: 1_700_000_000,
    metadata: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const events: BackendStreamEvent[] = [
  makeEvent({ id: "a", eventType: "CREATED", streamId: 10, amount: "500", timestamp: 100, transactionHash: "0xAAA" }),
  makeEvent({ id: "b", eventType: "WITHDRAWN", streamId: 11, amount: "900", timestamp: 200, transactionHash: "0xBBB" }),
  makeEvent({ id: "c", eventType: "PAUSED", streamId: 12, amount: null, timestamp: 300, transactionHash: "0xCCC" }),
];

describe("filterActivityEvents", () => {
  it("returns everything when no filters are given", () => {
    expect(filterActivityEvents(events)).toHaveLength(3);
  });

  it("filters by event type", () => {
    const types: StreamEventType[] = ["CREATED", "PAUSED"];
    const result = filterActivityEvents(events, { types });
    expect(result.map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("filters by inclusive timestamp range", () => {
    const filters: ActivityFilters = { fromTimestamp: 150, toTimestamp: 300 };
    expect(filterActivityEvents(events, filters).map((e) => e.id)).toEqual([
      "b",
      "c",
    ]);
  });

  it("searches tx hash case-insensitively and by stream id", () => {
    expect(filterActivityEvents(events, { search: "0xbbb" }).map((e) => e.id)).toEqual(["b"]);
    expect(filterActivityEvents(events, { search: "12" }).map((e) => e.id)).toEqual(["c"]);
  });

  it("combines filters (AND semantics)", () => {
    const result = filterActivityEvents(events, {
      types: ["WITHDRAWN", "PAUSED"],
      fromTimestamp: 250,
    });
    expect(result.map((e) => e.id)).toEqual(["c"]);
  });
});

describe("sortActivityEvents", () => {
  it("sorts by amount descending, treating null as zero", () => {
    const result = sortActivityEvents(events, "amount", "desc");
    expect(result.map((e) => e.id)).toEqual(["b", "a", "c"]);
  });

  it("sorts by timestamp ascending", () => {
    const result = sortActivityEvents(events, "timestamp", "asc");
    expect(result.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("is stable for equal keys", () => {
    const tied = [
      makeEvent({ id: "x", amount: "5" }),
      makeEvent({ id: "y", amount: "5" }),
      makeEvent({ id: "z", amount: "5" }),
    ];
    expect(sortActivityEvents(tied, "amount").map((e) => e.id)).toEqual([
      "x",
      "y",
      "z",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [...events];
    sortActivityEvents(input, "streamId", "asc");
    expect(input.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });
});
