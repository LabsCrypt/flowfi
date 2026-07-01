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
```

## Prisma Database

We use Prisma as our ORM to interact with PostgreSQL.

- Schema is located at `prisma/schema.prisma`.
- Run `npx prisma studio` to view the database through a web UI.

## /v1 API

All REST API endpoints are prefixed with `/v1`. Refer to the API Documentation in the root `README.md` and the `docs/` folder for versioning and authentication details.

## Server-Sent Events (SSE)

The backend exposes an SSE endpoint (`/v1/streams/events`) to stream real-time updates to the frontend whenever on-chain stream events are indexed.
