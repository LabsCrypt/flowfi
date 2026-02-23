
---

# Contributing to FlowFi

Thank you for your interest in contributing to **FlowFi**

FlowFi is a DeFi payment streaming protocol built on Stellar using Soroban smart contracts. This guide explains how to set up your local development environment and contribute effectively.

Please read this document carefully before opening a Pull Request.

---

##  Table of Contents

* [Project Overview](#project-overview)
* [Local Development Setup](#local-development-setup)
* [Branching Strategy](#branching-strategy)
* [Commit Guidelines & Hooks](#commit-guidelines--hooks)
* [Pull Request Process](#pull-request-process)
* [Security](#security)
* [Code of Conduct](#code-of-conduct)

---

##  Project Overview

FlowFi is structured as a monorepo:

```
flowfi/
├── backend/      # Express.js + TypeScript backend
├── contracts/    # Soroban smart contracts (Rust)
├── frontend/     # Next.js + Tailwind CSS frontend
```

Technologies used:

* **Frontend**: Next.js + TypeScript + Tailwind CSS
* **Backend**: Express.js + TypeScript
* **Smart Contracts**: Rust + Soroban
* **Database**: PostgreSQL
* **Containerization**: Docker & Docker Compose

---

#  Local Development Setup


##  Fork & Clone the Repository

Fork & Clone the Repository

First, fork the repository on GitHub.

Then clone your fork locally:

```bash
git clone https://github.com/YOUR-USERNAME/flowfi.git
cd flowfi
```

##  Prerequisites

Make sure you have the following installed:

* Node.js (LTS recommended)
* npm
* Rust & Cargo
* Docker & Docker Compose
* (Optional) Stellar CLI

---

##  Option 1: Docker (Recommended)

The fastest way to run the full stack locally:

```bash
docker compose up --build
```

This starts:

* PostgreSQL (port 5432)
* Backend API (port 3001)

To run in detached mode:

```bash
docker compose up -d --build
```

To stop services:

```bash
docker compose down
```

To reset the database:

```bash
docker compose down -v
```

---

##  Option 2: Manual Setup

### Backend Setup

1. **Install Dependencies**

```bash
cd backend
npm install
```

2. **Set Up Database**

The backend uses PostgreSQL. You can either:
- Use Docker Compose (recommended): `docker compose up postgres -d`
- Or set up PostgreSQL locally and configure `DATABASE_URL` in your `.env` file

3. **Run Database Migrations**

```bash
npm run prisma:generate
npm run prisma:migrate
```

4. **Start Development Server**

```bash
npm run dev
```

Backend runs on: `http://localhost:3001`

**Available Backend Scripts:**
- `npm run dev` - Start development server with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm run start` - Start production server
- `npm run test` - Run test suite
- `npm run prisma:generate` - Generate Prisma client
- `npm run prisma:migrate` - Run database migrations
- `npm run prisma:studio` - Open Prisma Studio (database GUI)

**Backend API Documentation:**
- Swagger UI: `http://localhost:3001/api-docs`
- OpenAPI Spec: `http://localhost:3001/api-docs.json`

---

### Frontend Setup

1. **Install Dependencies**

```bash
cd frontend
npm install
```

2. **Start Development Server**

```bash
npm run dev
```

Frontend runs on: `http://localhost:3000`

**Available Frontend Scripts:**
- `npm run dev` - Start Next.js development server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Run ESLint

**Environment Variables:**
Create a `.env.local` file in the `frontend` directory if needed for API endpoints or other configuration.

---

### Smart Contracts Setup

1. **Install Rust Toolchain**

Make sure you have Rust and Cargo installed. If not:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

2. **Install Soroban CLI** (if not already installed)

```bash
cargo install --locked soroban-cli
```

3. **Build Contracts**

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

The compiled WASM files will be in `target/wasm32-unknown-unknown/release/`.

**Contract Development:**
- Contract source: `contracts/stream_contract/src/lib.rs`
- Tests: `contracts/stream_contract/src/test.rs`
- Build target: `wasm32-unknown-unknown`

---

## Development Scripts & Tools

### Root-Level Scripts

From the repository root:

```bash
# Verify security setup
npm run verify-security
```

### Docker Compose Commands

```bash
# Start all services
docker compose up --build

# Start in detached mode
docker compose up -d --build

# View logs
docker compose logs -f

# Stop services
docker compose down

# Reset database (removes volumes)
docker compose down -v
```

---

## CI/CD Workflows

This repository uses GitHub Actions for continuous integration. Workflows are located in `.github/workflows/`.

### Available Workflows

- **Security Checks** (`.github/workflows/security.yml`)
  - Runs on: push to `main`/`develop`, pull requests, and weekly schedule
  - Performs:
    - Dependency vulnerability scanning (`npm audit`)
    - CodeQL analysis for JavaScript/TypeScript
  - View workflow: [Security Checks](.github/workflows/security.yml)

### Running CI Checks Locally

Before pushing, ensure your changes pass:

```bash
# Frontend linting
cd frontend && npm run lint

# Backend tests
cd backend && npm run test

# Security verification
npm run verify-security
```

For more details, see the [Security Workflow](.github/workflows/security.yml).

---

#  Branching Strategy

❌ Do NOT commit directly to `main`
✅ Always create a feature branch

## Branch Naming Convention

| Type     | Format                       | Example                       |
| -------- | ---------------------------- | ----------------------------- |
| Feature  | `feature/short-description`  | `feature/add-stream-cancel`   |
| Bug Fix  | `fix/short-description`      | `fix/dashboard-loading-error` |
| Refactor | `refactor/short-description` | `refactor/api-service-layer`  |
| Docs     | `docs/short-description`     | `docs/update-contributing`    |
| Infra    | `infra/short-description`    | `infra/docker-improvement`    |

## Create a Branch

```bash
git checkout -b feature/your-feature-name
```

Keep branch names short and descriptive.

---

#  Commit Guidelines & Hooks

This repository uses **Husky** for commit hooks.

Before committing, ensure:

* Code compiles
* Lint passes
* No broken builds

## Commit Message Format

We follow a conventional style:

```
type(scope): short description
```

### Examples

```
feat(frontend): add wallet balance card
fix(backed): resolve stream validation bug
refactor(contracts): simplify transfer logic
docs: update setup instructions
```

## Commit Rules

* Use present tense ("add", not "added")
* Keep subject under ~72 characters
* Make atomic commits (one logical change per commit)
* Avoid vague messages like "update stuff"

---

#  Pull Request Process

##  Sync with Main

Before opening a PR:

```bash
git checkout main
git pull origin main
git checkout your-branch
git rebase main
```

Resolve conflicts locally if any.

---

##  Push Your Branch

```bash
git push origin your-branch-name
```

---

## 3 Open a Pull Request

When opening your PR:

* Provide a clear title
* Add a detailed description
* Link related issues (e.g., `Closes #45`)
* Add screenshots for UI changes
* Explain why the change is needed

---

##  PR Requirements

Your PR must:

* Build successfully
* Pass lint checks
* Follow commit conventions
* Be properly described
* Stay focused (avoid large unrelated changes)

---

##  Code Review

Maintainers may:

* Request changes
* Ask clarifying questions
* Suggest improvements

Please respond respectfully and update your branch as requested.

---

# 🔒 Security

If you discover a security vulnerability, please do **NOT** open a public issue. Instead, follow our responsible disclosure process outlined in our [Security Policy](SECURITY.md).

Security vulnerabilities should be reported privately to allow us to address them before public disclosure.

---

# 📜 Code of Conduct

This project follows a Code of Conduct to ensure a welcoming and inclusive community.

Please read and follow our Code of Conduct before contributing:

 **[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)**

Be respectful.
Be collaborative.
Be constructive.

---

#  Final Notes

* Contributions of all sizes are welcome
* Documentation improvements are valuable
* Ask questions in Issues if unsure
* Keep PRs small and manageable

Thank you for helping improve FlowFi 💙
