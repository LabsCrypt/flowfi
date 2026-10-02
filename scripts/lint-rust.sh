#!/usr/bin/env bash
#
# Pre-commit Rust checks for the Soroban contracts.
#
# Invoked by lint-staged when any `contracts/**/*.rs` file is staged. Mirrors
# the `contracts` job in .github/workflows/ci.yml so formatting/lint issues are
# caught before they reach CI.
#
# lint-staged appends the staged file paths as arguments; cargo operates on the
# whole crate, so they are intentionally ignored.
#
# Exits 0 (without checking) when Cargo is not installed, so the hook never
# blocks contributors who don't have a Rust toolchain locally.
set -euo pipefail

if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo not found — skipping Rust fmt/clippy checks (install Rust to enable)."
  exit 0
fi

# Resolve the repo root regardless of the caller's cwd.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$REPO_ROOT/contracts"

if [[ ! -f "$CONTRACTS_DIR/Cargo.toml" ]]; then
  echo "contracts/Cargo.toml not found — skipping Rust checks."
  exit 0
fi

cd "$CONTRACTS_DIR"

echo "cargo fmt --all -- --check"
cargo fmt --all -- --check

echo "cargo clippy --all-targets -- -D warnings"
cargo clippy --all-targets -- -D warnings

echo "Rust formatting and lints passed."
