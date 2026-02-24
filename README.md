# FlowFi

**DeFi Payment Streaming on Stellar**

*Programmable, real-time payment streams and recurring subscriptions.*

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
│   └── ARCHITECTURE.md   # Architecture overview
```

## Architecture

FlowFi consists of three main components that work together:

- **Soroban Smart Contracts**: Handle on-chain payment stream logic
- **Backend API**: Indexes on-chain events, provides REST API, and streams real-time updates via SSE
- **Frontend**: User interface for creating and managing payment streams

For a detailed explanation of how these components interact, where event indexing happens, and the overall system architecture, see the [Architecture Documentation](docs/ARCHITECTURE.md).

## Getting Started

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

### Smart Contracts

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

## API Documentation

The FlowFi backend API uses URL-based versioning. All endpoints are prefixed with a version (e.g., `/v1/streams`).

- **API Versioning Guide**: [backend/docs/API_VERSIONING.md](backend/docs/API_VERSIONING.md)
- **Deprecation Policy**: [backend/docs/DEPRECATION_POLICY.md](backend/docs/DEPRECATION_POLICY.md)
- **Sandbox Mode**: [backend/docs/SANDBOX_MODE.md](backend/docs/SANDBOX_MODE.md) - Test without affecting production data
- **API Docs**: Available at `http://localhost:3001/api-docs` when backend is running

### Sandbox Mode

FlowFi supports sandbox mode for safe testing. Enable it by:

1. Setting `SANDBOX_MODE_ENABLED=true` in your `.env` file
2. Adding `X-Sandbox-Mode: true` header or `?sandbox=true` query parameter to requests

Sandbox mode uses a separate database and clearly labels all responses. See [Sandbox Mode Documentation](backend/docs/SANDBOX_MODE.md) for details.

## Contributing

Contributions are welcome! Please see our [Contributing Guide](CONTRIBUTING.md) for:
- Local development setup instructions
- Code style and commit guidelines
- Pull request process
- Development scripts and CI workflows

For architecture details, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Security

If you discover a security vulnerability, please see our [Security Policy](SECURITY.md) for information on how to report it responsibly.

## Contributors

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

This project follows the [all-contributors](https://github.com/all-contributors/all-contributors) specification. Contributions of any kind welcome!

## License

MIT
