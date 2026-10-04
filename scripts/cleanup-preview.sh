#!/usr/bin/env bash
#
# Teardown an ephemeral FlowFi preview environment when a PR closes/merges.
#
# Usage:
#   bash scripts/cleanup-preview.sh --pr <number>
#
# Destroys, in order:
#   1. The Fly.io preview app (when FLY_API_TOKEN is set).
#   2. The Neon/Supabase database branch (when provider secrets are set).
#   3. The local `flowfi_preview_pr_<N>` database (CI/service postgres).
#
set -euo pipefail

PR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr) PR="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PR" ]]; then
  echo "Error: --pr <number> is required" >&2
  exit 1
fi

DB_NAME="flowfi_preview_pr_${PR}"
APP_NAME="flowfi-pr-${PR}"
DATABASE_URL="${DATABASE_URL:-postgresql://postgres:password@127.0.0.1:5432/flowfi_preview}"

echo "==> Tearing down preview for PR #${PR}"

if [[ -n "${FLY_API_TOKEN:-}" ]] && command -v flyctl > /dev/null 2>&1; then
  echo "Destroying Fly app ${APP_NAME}..."
  flyctl apps destroy "${APP_NAME}" --yes || echo "Fly app ${APP_NAME} already gone."
else
  echo "Skipping Fly teardown (no token/flyctl)."
fi

if [[ -n "${NEON_API_KEY:-}" && -n "${NEON_PROJECT_ID:-}" ]]; then
  echo "Deleting Neon branch preview-pr-${PR}..."
  BRANCH_ID=$(curl --silent -H "Authorization: Bearer ${NEON_API_KEY}" \
    "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches" | \
    grep -o "\"id\":\"[^\"]*\"[^}]*preview-pr-${PR}[^}]*" | head -n1 | cut -d'"' -f4 || true)
  if [[ -n "${BRANCH_ID:-}" ]]; then
    curl --silent --fail --show-error -X DELETE \
      -H "Authorization: Bearer ${NEON_API_KEY}" \
      "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches/${BRANCH_ID}" > /dev/null || true
  fi
  echo "Neon branch cleanup attempted."
fi

if command -v psql > /dev/null 2>&1; then
  echo "Dropping database ${DB_NAME}..."
  psql "${DATABASE_URL}" -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid <> pg_backend_pid();" || true
  psql "${DATABASE_URL}" -c "DROP DATABASE IF EXISTS \"${DB_NAME}\"" || echo "Database drop skipped (no access)."
else
  echo "psql not found — skipping local database drop."
fi

# Best-effort docker cleanup for CI-validated preview containers.
docker rm -f "flowfi-preview-${PR}" > /dev/null 2>&1 || true

echo "Preview teardown complete for PR #${PR}."
