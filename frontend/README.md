# FlowFi Frontend

This is the Next.js frontend for FlowFi, providing the user interface for creating and managing continuous payment streams and recurring subscriptions.

## Purpose

The frontend connects to the FlowFi backend API and interacts with the Freighter wallet to allow users to sign transactions and manage their streams.

## Layout

- `src/app/`: Next.js App Router pages and layouts.
- `src/components/`: Reusable React components.
- `src/hooks/`: Custom React hooks for API and wallet integration.
- `src/lib/`: Utility functions and shared logic.

## Environment Variables

Create a `.env.local` file with the following variables:

```env
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
NEXT_PUBLIC_RPC_URL=https://soroban-testnet.stellar.org
```

## Scripts

- `npm run dev`: Starts the development server.
- `npm run build`: Builds the app for production.
- `npm start`: Runs the production server.
- `npm run lint`: Runs ESLint to check for code issues.
