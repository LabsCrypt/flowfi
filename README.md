# FlowFi

**DeFi Payment Streaming on Stellar**

_Programmable, real-time payment streams and recurring subscriptions._

## Overview

FlowFi allows users to create continuous payment streams and recurring subscriptions using stablecoins on the Stellar network. By leveraging Soroban smart contracts, FlowFi enables autonomous accurate-to-the-second distribution of funds.

## Features

- **Real-time Streaming**: Pay by the second for services or salaries.
- **Recurring Subscriptions**: Automate monthly or weekly payments.
- **Soroban Powered**: Secure and efficient execution on Stellar's smart contract platform.

## Project Structure

```
flowfi/
├── backend/              # Express.js + TypeScript backend
├── contracts/            # Soroban smart contracts
│   ├── stream_contract/  # Core streaming logic
├── frontend/             # Next.js + Tailwind CSS frontend
├── docs/                 # Documentation
│   ├── ARCHITECTURE.md   # Architecture overview
│   └── DEVELOPMENT.md    # Local development guide
```

## Architecture

FlowFi consists of three main components that work together:

- **Soroban Smart Contracts**: Handle on-chain payment stream logic.
- **Backend API**: Indexes on-chain events, provides REST API, and streams real-time updates via SSE
- **Frontend**: User interface for creating and managing payment streams

For a detailed explanation of how these components interact, where event indexing happens, and the overall system architecture, see the [Architecture Documentation](docs/ARCHITECTURE.md).

For full local setup and contributor onboarding, see the [Development Guide](docs/DEVELOPMENT.md).

## Getting Started

For full step-by-step instructions, see our [Development Guide](docs/DEVELOPMENT.md).

### Prerequisites

- Node.js & npm
- Rust & Cargo
- Stellar CLI (optional but recommended)
- Docker & Docker Compose (for containerized setup)

### Docker (Recommended)

The fastest way to run the full stack locally:

```bash
docker compose up --build
```

This starts:

- **Postgres** database on port `5432`
- **Backend** API on port `3001`

To run in detached mode:

```bash
docker compose up -d --build
```

To stop the services:

```bash
docker compose down
```

To reset the database:

```bash
docker compose down -v
```

### Backend (Manual)

```bash
cd backend
npm install
npm run dev
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### Deployment

To build, optimize, and deploy the smart contract to a Stellar network, you can use the automated deployment script:

```bash
./scripts/deploy.sh --network testnet
```

## Deployment

### Contract Deployment

The FlowFi smart contracts can be deployed to both testnet and mainnet using the automated deployment script.

#### Prerequisites

- Stellar CLI installed and configured
- Sufficient XLM in the deployment account for network fees
- Required environment variables set

#### Environment Variables

Before deploying, set the following environment variables:

```bash
export STELLAR_SECRET_KEY="your_secret_key_here"
export ADMIN_ADDRESS="your_admin_address_here"
export TREASURY_ADDRESS="your_treasury_address_here"
export FEE_RATE_BPS="25"  # 0.25% fee rate
```

#### Deploy to Testnet

```bash
npx tsx scripts/deploy.ts --network testnet
```

#### Deploy to Mainnet

```bash
npx tsx scripts/deploy.ts --network mainnet
```

#### Deployment Process

The deployment script automates the following steps:

1. **Build WASM**: Compiles the Rust contract to WebAssembly
2. **Optimize WASM**: Optimizes the WASM for deployment size
3. **Deploy Contract**: Deploys the contract to the specified network
4. **Initialize Contract**: Sets up admin, treasury, and fee rate parameters
5. **Save Deployment Info**: Stores contract details in `deployment-info.json`

#### Deployment Information

After successful deployment, contract details are saved to `deployment-info.json`:

```json
{
  "testnet": {
    "network": "testnet",
    "contractId": "CD...ID",
    "deployedAt": "2024-01-01T00:00:00.000Z",
    "adminAddress": "G...ADMIN",
    "treasuryAddress": "G...TREASURY",
    "feeRateBps": 25,
    "transactionHash": "TX...HASH"
  },
  "mainnet": {
    "network": "mainnet",
    "contractId": "CD...ID",
    "deployedAt": "2024-01-01T00:00:00.000Z",
    "adminAddress": "G...ADMIN",
    "treasuryAddress": "G...TREASURY",
    "feeRateBps": 25,
    "transactionHash": "TX...HASH"
  },
  "lastUpdated": "2024-01-01T00:00:00.000Z"
}
```

#### Manual Deployment

If you prefer to deploy manually, you can use the Stellar CLI directly:

```bash
# Build and optimize
cd contracts
cargo build --target wasm32-unknown-unknown --release
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/stream_contract.wasm

# Deploy
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/stream_contract.optimized.wasm --source YOUR_SECRET_KEY --network https://soroban-testnet.stellar.org

# Initialize
stellar contract invoke --id CONTRACT_ID --source YOUR_SECRET_KEY --network https://soroban-testnet.stellar.org initialize --admin ADMIN_ADDRESS --treasury TREASURY_ADDRESS --fee_rate_bps 25
```

## API Documentation

The FlowFi backend API uses URL-based versioning. All endpoints are prefixed with a version (e.g., `/v1/streams`).

- **API Versioning Guide**: [backend/docs/API_VERSIONING.md](backend/docs/API_VERSIONING.md)
- **Deprecation Policy**: [backend/docs/DEPRECATION_POLICY.md](backend/docs/DEPRECATION_POLICY.md)
- **Sandbox Mode**: [backend/docs/SANDBOX_MODE.md](backend/docs/SANDBOX_MODE.md) - Test without affecting production data
- **Interactive API Docs**: Available at `http://localhost:3001/api-docs` when backend is running
- **Raw OpenAPI JSON**: Available at `http://localhost:3001/api-docs.json` when backend is running

### Sandbox Mode

FlowFi supports sandbox mode for safe testing. Enable it by:

1. Setting `SANDBOX_MODE_ENABLED=true` in your `.env` file
2. Adding `X-Sandbox-Mode: true` header or `?sandbox=true` query parameter to requests

Sandbox mode uses a separate database and clearly labels all responses. See [Sandbox Mode Documentation](backend/docs/SANDBOX_MODE.md) for details.

## API Collections

Pre-built collections for exploring all endpoints without any manual setup.

| File | Client |
|---|---|
| [`docs/api/flowfi.postman_collection.json`](docs/api/flowfi.postman_collection.json) | Postman |
| [`docs/api/flowfi.hoppscotch_collection.json`](docs/api/flowfi.hoppscotch_collection.json) | Hoppscotch |

Environment files (import alongside the collection):

| File | Target |
|---|---|
| [`docs/api/local.postman_environment.json`](docs/api/local.postman_environment.json) | Postman — local |
| [`docs/api/test.postman_environment.json`](docs/api/test.postman_environment.json) | Postman — test |
| [`docs/api/local.hoppscotch_environment.json`](docs/api/local.hoppscotch_environment.json) | Hoppscotch — local |
| [`docs/api/test.hoppscotch_environment.json`](docs/api/test.hoppscotch_environment.json) | Hoppscotch — test |

### Quick start

**Postman**
1. *Import* → select `flowfi.postman_collection.json`.
2. *Import* → select the matching `*.postman_environment.json`.
3. Pick the environment from the top-right dropdown and send requests.

**Hoppscotch**
1. *Collections* → *Import / Export* → *Import from JSON* → select `flowfi.hoppscotch_collection.json`.
2. *Environments* → *Import* → select the matching `*.hoppscotch_environment.json`.
3. Activate the environment and send requests.

### SSE note

`GET /events/subscribe` streams `text/event-stream` data and keeps the connection open. Postman buffers the response — use *Send and Download* to capture it, or test interactively with:

```bash
curl -N --no-buffer 'http://localhost:3001/events/subscribe?all=true'
```

Or open `backend/test-sse-client.html` directly in a browser.

## Contributing

Contributions are welcome! Please see our [Contributing Guide](CONTRIBUTING.md) for:

- Local development setup instructions
- Code style and commit guidelines
- Pull request process
- Development scripts and CI workflows

Before your first change, run through the [Development Guide](docs/DEVELOPMENT.md) and review [Architecture Documentation](docs/ARCHITECTURE.md).

For architecture details, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Security

If you discover a security vulnerability, please see our [Security Policy](SECURITY.md) for information on how to report it responsibly.

## Community & Support

Have questions? Want to share ideas or projects? Join the conversation!

- **❓ [Ask Questions](https://github.com/flowfi/flowfi/discussions/categories/q-a)** - Get help in GitHub Discussions Q&A
- **💡 [Share Ideas](https://github.com/flowfi/flowfi/discussions/categories/ideas)** - Propose features and discuss improvements
- **🎪 [Show and Tell](https://github.com/flowfi/flowfi/discussions/categories/show-and-tell)** - Share projects and use cases built with FlowFi
- **📖 [Discussions Guide](DISCUSSIONS.md)** - Learn when to use Discussions vs Issues.

## Contributors

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

This project follows the [all-contributors](https://github.com/all-contributors/all-contributors) specification. Contributions of any kind welcome

## License

MIT.
