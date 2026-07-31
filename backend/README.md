# FlowFi Backend

This is the Node.js / Express backend for FlowFi. It provides the REST API for the frontend, indexes on-chain events from the Stellar network, and serves real-time updates via Server-Sent Events (SSE).

## Scripts

- `npm install`: Installs dependencies.
- `npm run dev`: Starts the development server using nodemon.
- `npm run build`: Compiles TypeScript to JavaScript.
- `npm start`: Runs the compiled server.
- `npm run db:push`: Pushes Prisma schema changes to the database.

## Environment Variables

Create a `.env` file with the following variables:

```env
DATABASE_URL=postgresql://user:password@localhost:5433/flowfi?schema=public
PORT=3001
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
API_BASE_URL=https://api.staging.flowfi.io
```

- `API_BASE_URL`: Overrides the Swagger UI server URL for the deployed environment (e.g., staging or production). When set, Swagger UI targets `<API_BASE_URL>/v1` instead of the hardcoded defaults.

## Prisma Database

We use Prisma as our ORM to interact with PostgreSQL.

- Schema is located at `prisma/schema.prisma`.
- Configuration (schema path, migrations path, datasource URL) is defined in `prisma.config.ts`.
- Run `npx prisma studio` to view the database through a web UI.

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

## /v1 API

All REST API endpoints are prefixed with `/v1`. Refer to the API Documentation in the root `README.md` and the `docs/` folder for versioning and authentication details.

## Server-Sent Events (SSE)

The backend exposes an SSE endpoint (`/v1/streams/events`) to stream real-time updates to the frontend whenever on-chain stream events are indexed.
