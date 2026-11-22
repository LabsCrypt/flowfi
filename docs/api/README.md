# API Collections

This directory contains hand-maintained Postman/Hoppscotch collections for exploring the FlowFi API.

**Source of truth:** [`backend/src/config/swagger.ts`](../../backend/src/config/swagger.ts) and the `@openapi` JSDoc annotations on each route. The generated spec is served live at `http://localhost:3001/api-docs` (UI) and `http://localhost:3001/api-docs.json` (raw OpenAPI JSON).

`flowfi.postman_collection.json` and `flowfi.hoppscotch_collection.json` are convenience collections for manual testing — they are not generated from the OpenAPI spec and can drift. When routes change:

1. Update the `@openapi` annotations on the affected route/controller first.
2. Re-check the endpoints in this directory's collections against `http://localhost:3001/api-docs.json` and update paths, methods, and bodies to match.
3. If a collection and the Swagger spec ever disagree, the Swagger spec wins.

## GraphQL API

FlowFi also exposes a read-only GraphQL endpoint at `/graphql`. It is intentionally **unversioned**: it is a convenience query surface over the same indexed data as the REST API, not part of the `/v1` contract, and its schema may change without a version bump. Integrators who need stability guarantees should use the versioned REST API (`/v1`).

- **Endpoint**: `POST /graphql` with `{ "query", "variables", "operationName" }`. `GET /graphql` serves a GraphiQL playground outside production and a short JSON notice in production.
- **Operations**: queries `stream(streamId)`, `streams(first, after, filter)` (cursor-paginated), and `accountOverview(address)`. There are **no mutations**. The `Subscription` type is a placeholder; real-time updates are delivered over the SSE gateway, not GraphQL.
- **Schema source**: `backend/src/graphql/schema.ts` (code-first nexus schema; resolvers in `backend/src/graphql/resolvers/`).
- **Auth model**: the endpoint does not require authentication and exposes only data that is already public on-chain/indexed (streams, events, token metadata, account positions). Nothing it serves is write-capable.
- **Limits**: there is no GraphQL-specific rate limit, query depth limit, or complexity limit. Only the global middleware applies (100kb JSON body limit). Operators who expose the API publicly should enforce rate limiting at the edge (reverse proxy/WAF).
- **OpenAPI/Postman coverage**: the OpenAPI spec (`/api-docs`) and the Postman/Hoppscotch collections cover REST only; GraphQL is not described there. Use the schema file above or GraphiQL (non-production) to explore it.
