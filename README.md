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
```

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

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request.

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
