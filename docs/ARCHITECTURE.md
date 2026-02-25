# FlowFi Architecture Overview

This document provides a high-level overview of how FlowFi's components interact and how the system processes on-chain events.

## System Components

FlowFi consists of three main components:

1. **Soroban Smart Contracts** - On-chain logic for payment streams
2. **Backend API** - Indexing, API endpoints, and real-time event streaming
3. **Frontend** - User interface built with Next.js

```
┌─────────────┐
│   Frontend  │ (Next.js + React)
│  (Port 3000)│
└──────┬──────┘
       │ HTTP/REST
       │ SSE (Server-Sent Events)
       ▼
┌─────────────┐
│   Backend   │ (Express.js + TypeScript)
│  (Port 3001)│
└──────┬──────┘
       │
       │ Indexes Events
       │ Queries State
       ▼
┌─────────────┐
│   Stellar   │
│   Network   │
└──────┬──────┘
       │
       │ Smart Contract
       │ Events & State
       ▼
┌─────────────┐
│  Soroban    │
│  Contracts  │ (Rust)
└─────────────┘
```

## Component Interactions

### 1. Soroban Smart Contracts

**Location:** `contracts/stream_contract/`

The smart contract handles all on-chain logic for payment streams:

- **Stream Creation**: Users create streams by depositing tokens
- **Withdrawals**: Recipients can withdraw available funds
- **Top-ups**: Senders can add more funds to active streams
- **Cancellation**: Senders can cancel streams and receive refunds

**Key Contract Functions:**
- `create_stream()` - Creates a new payment stream
- `withdraw()` - Withdraws available funds from a stream
- `top_up_stream()` - Adds funds to an existing stream
- `cancel_stream()` - Cancels a stream and refunds remaining balance
- `get_stream()` - Reads stream state

**Events Emitted:**
The contract emits events for all state changes:
- `stream_created` - When a new stream is created
- `tokens_withdrawn` - When funds are withdrawn
- `stream_topped_up` - When additional funds are added
- `stream_cancelled` - When a stream is cancelled

### 2. Backend API

**Location:** `backend/`

The backend serves multiple purposes:

#### A. Event Indexing

**Where Indexing Happens:**

The backend indexes on-chain events from Soroban contracts. The indexing process:

1. **Event Detection**: The backend listens to Stellar network events (via Stellar Horizon API or similar)
2. **Event Processing**: When contract events are detected, they are processed and stored
3. **Database Storage**: Events are stored in PostgreSQL using Prisma ORM

**Database Models:**
- `Stream` - Mirrors on-chain stream state for fast querying
- `StreamEvent` - Stores all on-chain events (CREATED, TOPPED_UP, WITHDRAWN, CANCELLED, COMPLETED)
- `User` - Tracks Stellar wallet addresses

**Indexing Implementation:**

The indexing logic is designed to be integrated with a Stellar event listener. See:
- `backend/src/services/indexer-integration.example.ts` - Example integration pattern
- `backend/prisma/schema.prisma` - Database schema for indexed data

**Event Types Indexed:**
- `CREATED` - Stream creation events
- `TOPPED_UP` - Additional funds added
- `WITHDRAWN` - Funds withdrawn by recipient
- `CANCELLED` - Stream cancellation
- `COMPLETED` - Stream completion (all funds withdrawn)

#### B. REST API

The backend provides REST endpoints for:

- **Stream Management**: Query stream state, create streams (via contract interaction)
- **User Data**: Get user streams, balances, history
- **Health Checks**: API status and metrics

**API Documentation:**
- Swagger UI: `http://localhost:3001/api-docs`
- OpenAPI Spec: `http://localhost:3001/api-docs.json`

#### C. Real-Time Event Streaming

**Server-Sent Events (SSE):**

The backend provides SSE endpoints for real-time updates:

- **Endpoint**: `GET /events/subscribe`
- **Purpose**: Push real-time stream updates to frontend clients
- **Event Types**: `stream.created`, `stream.topped_up`, `stream.withdrawn`, `stream.cancelled`, `stream.completed`

**How It Works:**
1. Frontend connects to SSE endpoint
2. Backend maintains connection and broadcasts events
3. When on-chain events are indexed, they trigger SSE broadcasts
4. Frontend receives real-time updates without polling

See `backend/docs/SSE_ARCHITECTURE.md` for detailed SSE implementation.

### 3. Frontend

**Location:** `frontend/`

The frontend is a Next.js application that:

- **Displays Streams**: Shows active streams, incoming/outgoing payments
- **Wallet Integration**: Connects to Stellar wallets (Freighter, etc.)
- **Real-Time Updates**: Subscribes to SSE events for live stream updates
- **Stream Management**: UI for creating, viewing, and managing streams

**Key Features:**
- Dashboard with stream overview
- Incoming/outgoing stream lists
- Real-time balance updates via SSE
- Wallet connection and transaction signing

## Data Flow

### Creating a Stream

1. **User Action**: User fills out stream creation form in frontend
2. **Frontend**: Prepares transaction and prompts wallet for signature
3. **Stellar Network**: Transaction is submitted and processed
4. **Contract**: `create_stream()` executes, emits `stream_created` event
5. **Backend Indexer**: Detects event, stores in database
6. **Backend SSE**: Broadcasts event to subscribed clients
7. **Frontend**: Receives SSE update, UI updates automatically

### Withdrawing from a Stream

1. **User Action**: Recipient clicks withdraw in frontend
2. **Frontend**: Prepares withdrawal transaction, prompts wallet
3. **Stellar Network**: Transaction submitted
4. **Contract**: `withdraw()` executes, emits `tokens_withdrawn` event
5. **Backend Indexer**: Detects event, updates database
6. **Backend SSE**: Broadcasts withdrawal event
7. **Frontend**: Updates balance and stream state

### Querying Stream State

1. **User Action**: User navigates to stream details page
2. **Frontend**: Makes REST API call to backend
3. **Backend**: Queries indexed database (fast, no on-chain call needed)
4. **Backend**: Returns stream data
5. **Frontend**: Displays stream information

For real-time accuracy, the frontend can also:
- Subscribe to SSE events for that specific stream
- Receive updates immediately when on-chain events occur

## Technology Stack

### Smart Contracts
- **Language**: Rust
- **Framework**: Soroban SDK
- **Build Target**: `wasm32-unknown-unknown`

### Backend
- **Runtime**: Node.js
- **Framework**: Express.js
- **Language**: TypeScript
- **Database**: PostgreSQL
- **ORM**: Prisma
- **Real-Time**: Server-Sent Events (SSE)

### Frontend
- **Framework**: Next.js 16
- **Language**: TypeScript
- **Styling**: Tailwind CSS
- **State Management**: React Context
- **Wallet Integration**: Stellar SDK

## Development Workflow

### Local Development

1. **Start Infrastructure**: `docker compose up` (PostgreSQL)
2. **Start Backend**: `cd backend && npm run dev`
3. **Start Frontend**: `cd frontend && npm run dev`
4. **Deploy Contracts**: Build and deploy to Stellar testnet

### Testing

- **Contracts**: Rust unit tests in contract source files
- **Backend**: Vitest for API and service tests
- **Frontend**: Next.js testing utilities

## Security Considerations

- **Rate Limiting**: Backend implements rate limiting on all endpoints
- **Input Validation**: Zod schemas validate all API inputs
- **Authentication**: Wallet-based authentication via Stellar signatures
- **Event Verification**: Indexed events are verified against on-chain state

## Future Enhancements

Potential areas for improvement:

- **Indexer Service**: Dedicated microservice for event indexing
- **Caching Layer**: Redis for frequently accessed stream data
- **WebSocket Support**: Alternative to SSE for bidirectional communication
- **GraphQL API**: More flexible querying for complex frontend needs

## Related Documentation

- [SSE Architecture](backend/docs/SSE_ARCHITECTURE.md) - Detailed SSE implementation
- [Backend README](backend/SSE_README.md) - Backend-specific documentation
- [Contributing Guide](../CONTRIBUTING.md) - Development setup and workflows
