/**
 * NOTE: These types are hand-written and must be manually kept in sync with
 * the backend's OpenAPI/swagger source of truth:
 *   backend/src/config/swagger.ts (JSDoc annotations on the route files feed
 *   swagger-jsdoc, which builds the spec served at /api-docs.json).
 *
 * An opt-in codegen script exists to help cross-check this file against the
 * live spec without replacing it automatically:
 *   `npm run codegen:api-types` (in frontend/) runs openapi-typescript
 *   against a locally running backend's /api-docs.json and writes the result
 *   to src/lib/api-types.generated.ts. It is NOT wired into CI and does NOT
 *   replace these hand-written types/call sites — run it manually, diff the
 *   output against this file, and update this file by hand when they drift.
 */
export interface BackendUser {
  id: string;
  publicKey: string;
  createdAt: string;
  updatedAt: string;
}

export type StreamEventType =
  | "CREATED"
  | "TOPPED_UP"
  | "WITHDRAWN"
  | "CANCELLED"
  | "COMPLETED"
  | "PAUSED"
  | "RESUMED"
  | "FEE_COLLECTED"
  | "FEE_CONFIG_UPDATED"
  | "ADMIN_TRANSFERRED";

export interface BackendStreamEvent {
  id: string;
  streamId: number;
  eventType: StreamEventType;
  amount: string | null;
  transactionHash: string;
  ledgerSequence: number;
  timestamp: number;
  metadata: string | null;
  createdAt: string;
}

export interface BackendStream {
  id: string;
  streamId: number;
  sender: string;
  recipient: string;
  tokenAddress: string;
  ratePerSecond: string;
  depositedAmount: string;
  withdrawnAmount: string;
  startTime: number;
  lastUpdateTime: number;
  endTime?: number | null;
  isActive: boolean;
  isPaused?: boolean;
  pausedAt?: number | null;
  totalPausedDuration?: number;
  createdAt: string;
  updatedAt: string;
  senderUser?: BackendUser;
  recipientUser?: BackendUser;
  events?: BackendStreamEvent[];
}
