# CI/CD Workflow

This directory contains GitHub Actions workflows for automated testing and validation.

## CI / Validation Workflow (`.github/workflows/test.yml`)

**Purpose**: Prevents regressions by running all test suites and linting on every pull request to main.

**Triggers**:

- Pull requests targeting the `main` branch

**What it does**:

1. **Setup**: Installs Rust (stable) and Node.js (v20) with dependency caching
2. **Dependency Installation**: Uses `npm install` for both backend and frontend
3. **Code Quality**: Runs linting on both backend and frontend (if configured)
4. **Backend Tests**: Runs `npm test` in `/backend` (Vitest + TypeScript)
5. **Frontend Tests**: Runs `npm test --if-present` in `/frontend` (no test framework configured yet)
6. **Smart Contract Tests**: Runs `cargo test` in `/contracts` (Rust)

**Failure Behavior**:

- Workflow fails if any test or linting step fails
- Blocks PR merge until all checks pass
- Uses `--if-present` to avoid failures when test scripts are missing

**Requirements for Contributors**:

- Ensure lint and test scripts are properly configured in `package.json`
- Tests must pass in all directories where they exist
- New dependencies should be added to respective `package.json` files
- Backend uses Vitest, frontend has no test framework configured yet
- react-hot-toast is available as a root dependency

**Note**: The workflow uses `continue-on-error: false` to ensure strict validation - any failure will prevent the PR from being merged.
