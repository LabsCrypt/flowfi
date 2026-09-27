import { createYoga } from "graphql-yoga";

import { buildContext } from "./context.js";
import { schema } from "./schema.js";

/**
 * GraphQL gateway mounted at `/graphql`.
 *
 * graphql-yoga is used rather than Apollo Server because it serves both
 * queries/mutations over `POST /graphql` and subscriptions over SSE on the same
 * endpoint with no extra WebSocket server to operate — which is what lets the
 * gateway reuse the existing Express app, rate limiter and security headers.
 *
 * `graphiql` is disabled in production; the introspection schema itself stays
 * available so integrators can generate typed clients.
 */
export const yoga = createYoga({
  schema,
  graphqlEndpoint: "/graphql",
  graphiql: process.env.NODE_ENV !== "production",
  landingPage: false,
  context: buildContext,
});

export default yoga;
