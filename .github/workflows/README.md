# CI/CD Workflow

This directory contains GitHub Actions workflows for automated testing and validation.

## Test Workflow (`.github/workflows/test.yml`)

**Purpose**: Prevents regressions by running all test suites on every pull request to main.

**Triggers**:

- Pull requests targeting the `main` branch

**What it does**:

1. **Setup**: Installs Rust (stable) and Node.js (v20) with dependency caching
2. **Backend Tests**: Runs `npm test` in `/backend` (Jest + TypeScript)
3. **Frontend Tests**: Runs `npm test` in `/frontend` (Jest + React Testing Library)
4. **Smart Contract Tests**: Runs `cargo test` in `/contracts` (Rust)

**Failure Behavior**:

- Workflow fails if any test suite fails
- Blocks PR merge until all tests pass

**Requirements for Contributors**:

- Ensure all test scripts are properly configured in `package.json`
- Tests must exist and pass in all three directories
- New dependencies should be added to respective `package.json` files

**Note**: The workflow uses `continue-on-error: false` to ensure strict validation - any test failure will prevent the PR from being merged.
