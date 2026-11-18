import type { StreamEventType } from "@/lib/api-types";
import type { TransactionAction } from "@/components/TransactionTracker";

const EVENT_ACTIONS: Partial<Record<StreamEventType, TransactionAction>> = {
  CREATED: "create",
  TOPPED_UP: "topup",
  WITHDRAWN: "withdraw",
  CANCELLED: "cancel",
  PAUSED: "pause",
  RESUMED: "resume",
};

/**
 * TransactionTracker action for an activity-history event, or null when the
 * event has no user-initiated transaction status to show (e.g. COMPLETED,
 * fee/admin events).
 */
export function eventTypeToAction(eventType: StreamEventType): TransactionAction | null {
  return EVENT_ACTIONS[eventType] ?? null;
}
