/**
 * NOTE: These types are hand-written and must be manually kept in sync with
 * the backend's OpenAPI/swagger source of truth:
 *   backend/src/config/swagger.ts (JSDoc annotations on the route files feed
 *   swagger-jsdoc, which builds the spec served at /api-docs.json).
 *
 * The checked-in `api-types.generated.ts` is produced from the committed spec
 * by `npm run codegen:api-types` (in frontend/), which runs openapi-typescript
 * against backend/swagger/flowfi.openapi.json. That generated file is the
 * machine-readable mirror of this hand-written contract and is enforced in CI:
 * the backend job re-exports the OpenAPI spec and regenerates the types, then
 * `git diff --exit-code` fails the build if either drifts. When this file
 * changes, update the backend spec/annotations and regenerate with:
 *
 *   cd backend && npm run codegen:openapi
 *   cd ../frontend && npm run codegen:api-types
 *
 * See the "API Types Drift Check" section of CONTRIBUTING.md. This file is
 * still maintained by hand because the generated output does not replace these
 * narrow, call-site-oriented interfaces.
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
