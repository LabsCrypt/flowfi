import { verifyJwt } from "../middleware/auth.js";
import { createDataloaders, type GraphQLDataloaders } from "./dataloaders/index.js";

/**
 * Per-request GraphQL execution context.
 *
 * Mirrors the REST layer's concerns: the bearer token is verified with the same
 * `verifyJwt` used by `optionalAuthMiddleware`, and each request gets its own
 * DataLoader set so batched lookups are never shared across users.
 */
export interface GraphQLAuth {
  publicKey: string;
}

export interface GraphQLContext {
  /** The original WHATWG request (headers, method, ...). */
  request: Request;
  /** Authenticated wallet, or `null` for anonymous callers. */
  auth: GraphQLAuth | null;
  /** Request-scoped batched loaders. */
  dataloaders: GraphQLDataloaders;
  /** Correlation id propagated from the HTTP middleware, when present. */
  requestId: string;
}

function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

/**
 * Builds the context for one GraphQL operation.
 *
 * Authorization is intentionally non-fatal here (matching
 * `optionalAuthMiddleware`): anonymous callers may read public stream data,
 * while resolvers that mutate or expose private data assert `ctx.auth`
 * themselves and raise a typed GraphQL error otherwise.
 */
export function buildContext({ request }: { request: Request }): GraphQLContext {
  const token = extractBearer(request);
  const payload = token ? verifyJwt(token) : null;

  return {
    request,
    auth: payload ? { publicKey: payload.publicKey } : null,
    dataloaders: createDataloaders(),
    requestId: request.headers.get("x-request-id") ?? "",
  };
}
