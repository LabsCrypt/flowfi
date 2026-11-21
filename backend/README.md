# FlowFi Backend

This is the Node.js / Express backend for FlowFi. It provides the REST API for the frontend, indexes on-chain events from the Stellar network, and serves real-time updates via Server-Sent Events (SSE).

## Scripts

- `npm install`: Installs dependencies.
- `npm run dev`: Starts the development server using nodemon.
  
  > **Note:** nodemon watches only the `src/` directory for changes. Tests live in the `tests/` directory (outside the watch scope), so they never trigger server reloads. If tests were ever colocated inside `src/` in the future, add ignore patterns (e.g. `src/**/*.test.ts`) to nodemon.json to prevent unwanted restarts.
- `npm run build`: Compiles TypeScript to JavaScript.
- `npm start`: Runs the compiled server.
- `npm run prisma:generate`: Generates the Prisma client.
- `npm run prisma:migrate`: Creates and applies a migration in development (`prisma migrate dev`).
- `npm run prisma:deploy`: Applies pending migrations in deployed environments (`prisma migrate deploy`).

## Environment Variables

Copy `.env.example` to `.env` and adjust the values. The minimum configuration is:

```env
DATABASE_URL=postgresql://user:password@localhost:5433/flowfi?schema=public
PORT=3001
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
API_BASE_URL=https://api.staging.flowfi.io
```

- `API_BASE_URL`: Overrides the Swagger UI server URL for the deployed environment (e.g., staging or production). When set, Swagger UI targets `<API_BASE_URL>/v1` instead of the hardcoded defaults.

## CORS

The CORS policy is built in `src/config/cors.ts` when the app starts and depends on `NODE_ENV`:

| | `NODE_ENV=production` | Any other value (or unset) |
|---|---|---|
| Allowed origins | `FRONTEND_URL` + `CORS_ALLOWED_ORIGINS`, exact match | Same, or `http://localhost:3000` if neither is set |
| Allowed request headers | `Content-Type`, `Authorization`, `X-Request-ID` | Whatever the preflight requests |
| Allowed methods | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` | `cors` defaults |
| Preflight cache (`Access-Control-Max-Age`) | `CORS_MAX_AGE_SECONDS` (default `7200`) | Not set |
| Credentials | Allowed | Allowed |

- **`FRONTEND_URL` is required in production.** Set it to the frontend origin, e.g. `FRONTEND_URL=https://app.flowfi.xyz`. Comma-separate several origins (e.g. preview domains). Each entry is normalised to its origin, so `https://app.flowfi.xyz/` works too. If no valid origin is configured, or any entry is not an absolute `http(s)` URL (including `*`), the server throws at startup instead of running with an open policy.
- **Set `NODE_ENV=production` in every deployed environment.** Otherwise the development policy applies (headers and methods unrestricted). The server logs a warning at startup when `NODE_ENV` is unset.
- Browser requests from any other origin get `403 {"error": {"code": "FORBIDDEN", "message": "CORS origin not allowed"}}` and no `Access-Control-Allow-Origin` header. The rejected origin is logged at `warn` level.
- Requests without an `Origin` header (health checks, webhooks, curl, server-to-server calls) are not affected.

## Prisma Database

We use Prisma as our ORM to interact with PostgreSQL.

- Schema is located at `prisma/schema.prisma`.
- Configuration (schema path, migrations path, datasource URL) is defined in `prisma.config.ts`.
- Run `npx prisma studio` to view the database through a web UI.

### `prisma.config.ts` vs `prisma/schema.prisma`

There are two Prisma files, and they do different jobs:

| File | Owns |
| ---- | ---- |
| `prisma/schema.prisma` | The **data model** — models, enums, relations, the `datasource` and `generator` blocks. This is what `prisma generate` turns into the client. |
| `prisma.config.ts` | The **Prisma CLI configuration** — where the CLI looks for things and how it connects when you run `prisma generate`, `prisma migrate`, `prisma db push`, or `prisma studio`. |

`prisma.config.ts` exists as a separate file because it is TypeScript that Node evaluates before the CLI runs, so it can do things `schema.prisma` cannot — most importantly read environment variables. Prisma 7 (this project is on `prisma@^7.4.1`) no longer auto-loads `.env` for CLI commands, which is why the file starts with `import "dotenv/config"`.

What it currently sets:

- `schema: "prisma/schema.prisma"` — path to the schema, so CLI commands work from the `backend/` directory without a `--schema` flag.
- `migrations.path: "prisma/migrations"` — where migration folders are read from and written to.
- `datasource.url: process.env["DATABASE_URL"]` — the connection string the CLI uses.

### Seeding the database

`prisma/seed.ts` populates the database with demo fixtures for local development. Run it with:

```bash
npm run prisma:seed
```

(this runs `prisma db seed`, which in turn runs `tsx prisma/seed.ts` as configured under the `prisma.seed` key in `package.json`.)

The script is idempotent (it uses `upsert`/fixed IDs), so it's safe to run multiple times. It creates:

- Two demo users, keyed by fixed Stellar testnet public keys — a sender (`GCM5WPR4DDR24FSAX5LIEM4J7AI3KOWJYANSXEPKYXCSZOTAYXE75AFN`) and a recipient (`GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3XKSOLXAUJSD56C4LHND5TWUC`).
- One demo `Stream` (`streamId: 101`) between those two users, using a fixed demo token address, with a sample rate/deposit amount and `isActive: true`.
- One demo `StreamEvent` (`eventType: 'CREATED'`) attached to that stream, with sample transaction hash, ledger sequence, and metadata.

These fixtures are intended purely for local development/demo purposes so the frontend has data to render out of the box; they are not used in automated tests.

### Troubleshooting

If a `prisma generate` / `prisma migrate` command misbehaves, check `prisma.config.ts` before assuming the schema is at fault:

- **"Environment variable not found: DATABASE_URL"** or the CLI connecting to the wrong database — the config resolves `DATABASE_URL` at load time via `dotenv/config`, so it reads `backend/.env`. A variable exported only in your shell after the process starts, or set in a `.env` outside `backend/`, will not be picked up.
- **CLI can't find the schema or migrations** — these paths are relative to `backend/`. Running `prisma` from the repo root will not resolve them.
- **`npm run prisma:seed` not running the seed script** — the seed command is declared in the legacy `prisma.seed` field in `package.json`. Prisma 7 expects it as `migrations.seed` in `prisma.config.ts`, so if seeding silently does nothing, check both places.

## /v1 API

All REST API endpoints are prefixed with `/v1`. Refer to the API Documentation in the root `README.md` and the `docs/` folder for versioning and authentication details.

### Error envelope

Every non-2xx JSON response has the same body, produced only by `sendApiError` (`src/lib/api-error.ts`) and by `ApiError` → `errorHandler` for thrown errors:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": ["sender"], "message": "Sender address is required", "code": "too_small" }]
  }
}
```

- `code` is stable and machine-readable — branch on it. `message` is display text and may change.
- `details` is present only when there is something to report and its shape depends on `code`: the failing zod issues for `VALIDATION_ERROR`, an object of remediation hints elsewhere.
- This covers 4xx and 5xx from every layer, including the rate limiter's `429 RATE_LIMITED`, the body-size `413 PAYLOAD_TOO_LARGE` and the CORS `403 FORBIDDEN`. The spec's `components.schemas.Error` in `swagger/flowfi.openapi.json` is the generated contract.

## Server-Sent Events (SSE)

The backend exposes an SSE endpoint (`/v1/streams/events`) to stream real-time updates to the frontend whenever on-chain stream events are indexed.

## Logging & Correlation IDs

Structured JSON logs generated by Winston (`backend/src/logger.ts`) attach a `requestId` correlation ID via `AsyncLocalStorage` (`requestContext`):
- **HTTP Requests:** Set via `requestIdMiddleware` (`X-Request-ID` header or auto-generated UUID). The middleware is mounted ahead of the global rate limiter, so a throttled `429` carries an id too, and `sendApiError` echoes that id as `error.requestId` in the JSON body.
- **Worker Poll Batches:** Each poll cycle in `SorobanEventWorker` runs in `requestContext.run({ requestId: randomUUID() }, ...)` so all event logs and error traces share a single ID per cycle.
- **Admin Replays:** Replays triggered via `replayFromLedger` / `POST /v1/admin/indexer/replay` execute under a shared `requestId` that is included in all indexer log statements and returned in the HTTP 202 JSON response.
