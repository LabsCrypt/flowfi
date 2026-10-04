import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import TransactionTracker from "@/components/TransactionTracker";
import type { StreamEventType } from "@/lib/api-types";
import { eventTypeToAction } from "./eventTypeToAction";

describe("eventTypeToAction (#1207)", () => {
  it.each<[StreamEventType, string]>([
    ["CREATED", "Stream created Successfully"],
    ["TOPPED_UP", "Topped up Successfully"],
    ["WITHDRAWN", "Withdrawn Successfully"],
    ["CANCELLED", "Stream cancelled Successfully"],
    ["PAUSED", "Stream paused Successfully"],
    ["RESUMED", "Stream resumed Successfully"],
  ])("%s renders %s", (eventType, text) => {
    const action = eventTypeToAction(eventType);
    expect(action).not.toBeNull();
    const { container } = render(<TransactionTracker status="confirmed" action={action!} txHash="abc" />);
    expect(container.textContent).toContain(text);
    if (eventType !== "WITHDRAWN") expect(container.textContent).not.toContain("Withdrawn Successfully");
  });

  it.each<StreamEventType>(["COMPLETED", "FEE_COLLECTED", "FEE_CONFIG_UPDATED", "ADMIN_TRANSFERRED"])(
    "%s has no transaction action",
    (eventType) => {
      expect(eventTypeToAction(eventType)).toBeNull();
    },
  );
});
