# API Collections

This directory contains hand-maintained Postman/Hoppscotch collections for exploring the FlowFi API.

**Source of truth:** [`backend/src/config/swagger.ts`](../../backend/src/config/swagger.ts) and the `@openapi` JSDoc annotations on each route. The generated spec is served live at `http://localhost:3001/api-docs` (UI) and `http://localhost:3001/api-docs.json` (raw OpenAPI JSON).

`flowfi.postman_collection.json` and `flowfi.hoppscotch_collection.json` are convenience collections for manual testing — they are not generated from the OpenAPI spec and can drift. When routes change:

1. Update the `@openapi` annotations on the affected route/controller first.
2. Re-check the endpoints in this directory's collections against `http://localhost:3001/api-docs.json` and update paths, methods, and bodies to match.
3. If a collection and the Swagger spec ever disagree, the Swagger spec wins.
