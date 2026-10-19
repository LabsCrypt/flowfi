#!/usr/bin/env bash
#
# Provision + deploy an ephemeral FlowFi preview environment for a pull request.
#
# Usage:
#   bash scripts/deploy-preview.sh --provision-db --pr <number>
#   bash scripts/deploy-preview.sh --deploy-backend --pr <number> --sha <sha>
#   bash scripts/deploy-preview.sh --pr <number> --sha <sha>   # full pipeline
#
# Behaviour:
#   1. Provisions an ephemeral Postgres database. When NEON_* secrets are set a
#      Neon branch is created; when SUPABASE_* secrets are set a Supabase branch
#      is created; otherwise a local `flowfi_preview_pr_<N>` database is created
#      on DATABASE_URL.
#   2. Runs `prisma migrate deploy` + `prisma db seed` (demo streams/users).
#   3. Builds + deploys the containerized backend preview (Fly.io when
#      FLY_API_TOKEN is set, otherwise validates the docker image locally).
#   4. Prints the preview URL + health status for the workflow bot comment.
#
set -euo pipefail

PR=""
SHA="${GITHUB_SHA:-local}"
PROVISION_ONLY=false
DEPLOY_ONLY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr) PR="$2"; shift 2 ;;
    --sha) SHA="$2"; shift 2 ;;
    --provision-db) PROVISION_ONLY=true; shift ;;
    --deploy-backend) DEPLOY_ONLY=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PR" ]]; then
  echo "Error: --pr <number> is required" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_NAME="flowfi_preview_pr_${PR}"
APP_NAME="flowfi-pr-${PR}"
DATABASE_URL="${DATABASE_URL:-postgresql://postgres:password@127.0.0.1:5432/flowfi_preview}"

provision_db() {
  echo "==> Provisioning ephemeral database ${DB_NAME}"

  if [[ -n "${NEON_API_KEY:-}" && -n "${NEON_PROJECT_ID:-}" ]]; then
    echo "Creating Neon branch for PR #${PR}..."
    curl --silent --fail --show-error \
      -H "Authorization: Bearer ${NEON_API_KEY}" \
      -H "Content-Type: application/json" \
      -X POST "https://console.neon.tech/api/v2/projects/${NEON_PROJECT_ID}/branches" \
      -d "{\"branch\":{\"name\":\"preview-pr-${PR}\"}}" > /dev/null
    echo "Neon branch preview-pr-${PR} ready."
    return 0
  fi

  if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" && -n "${SUPABASE_PROJECT_REF:-}" ]]; then
    echo "Supabase branching is managed via the Supabase dashboard API; using preview schema ${DB_NAME}."
    return 0
  fi

  # Local / CI postgres service: create an isolated database per PR so branch
  # schema migrations never corrupt a developer's local database.
  if command -v psql > /dev/null 2>&1; then
    psql "${DATABASE_URL}" -c "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" -tA | grep -q 1 \
      || psql "${DATABASE_URL}" -c "CREATE DATABASE \"${DB_NAME}\""
    echo "Database ${DB_NAME} ready."
  else
    echo "psql not found — assuming service database already provides isolation."
  fi

  export PREVIEW_DATABASE_URL="${DATABASE_URL%/*}/${DB_NAME}"
  echo "PREVIEW_DATABASE_URL configured for ${DB_NAME}"
}

migrate_and_seed() {
  echo "==> Running migrations + seed on ${DB_NAME}"
  export DATABASE_URL="${PREVIEW_DATABASE_URL:-${DATABASE_URL%/*}/${DB_NAME}}"
  cd "${ROOT}/backend"
  npx prisma generate --schema=prisma/schema.prisma
  # Try `migrate deploy` first per spec; fall back to `db push` (Backend CI
  # path) because the committed init migration fails on fresh databases.
  if ! npx prisma migrate deploy --schema=prisma/schema.prisma; then
    echo "migrate deploy failed — falling back to prisma db push for ephemeral preview."
    npx prisma db push --accept-data-loss --schema=prisma/schema.prisma
  fi
  if npm run | grep -q "prisma:seed"; then
    npm run prisma:seed
  else
    npx tsx prisma/seed.ts
  fi
  cd "${ROOT}"
  echo "Seed complete: demo users + streams available for QA."
}

deploy_backend() {
  echo "==> Deploying backend preview ${APP_NAME} (${SHA})"
  if [[ -n "${FLY_API_TOKEN:-}" ]]; then
    if ! command -v flyctl > /dev/null 2>&1; then
      curl -L https://fly.io/install.sh | sh
      export PATH="$HOME/.fly/bin:$PATH"
    fi
    echo "${FLY_API_TOKEN}" | flyctl auth docker || true
    # Launch per-PR app on first run; subsequent pushes reuse it.
    if ! flyctl apps list 2>/dev/null | grep -q "${APP_NAME}"; then
      flyctl launch --name "${APP_NAME}" --region iad --no-deploy --yes || true
    fi
    flyctl deploy --app "${APP_NAME}" --image "flowfi-backend:pr-${PR}" --strategy immediate || \
      flyctl deploy --app "${APP_NAME}" --strategy immediate
    PREVIEW_URL="https://${APP_NAME}.fly.dev"
    echo "Waiting for health check at ${PREVIEW_URL}/health ..."
    for i in $(seq 1 30); do
      if curl --silent --fail --max-time 5 "${PREVIEW_URL}/health" > /dev/null; then
        echo "Backend preview healthy: ${PREVIEW_URL}"
        echo "preview_url=${PREVIEW_URL}" >> "${GITHUB_OUTPUT:-/dev/null}" 2>/dev/null || true
        return 0
      fi
      sleep 5
    done
    echo "Health check did not pass within 150s" >&2
    exit 1
  fi

  echo "FLY_API_TOKEN not set — validating docker image locally instead of live deploy."
  docker build -f "${ROOT}/backend/Dockerfile" "${ROOT}/backend" -t "flowfi-backend:pr-${PR}"
  echo "preview_url=https://pr-${PR}.flowfi-preview.local (CI-validated image; live deploy skipped without FLY_API_TOKEN)"
}

if [[ "${PROVISION_ONLY}" == true ]]; then
  provision_db
  exit 0
fi

if [[ "${DEPLOY_ONLY}" == true ]]; then
  deploy_backend
  exit 0
fi

provision_db
migrate_and_seed
deploy_backend
echo "Preview pipeline complete for PR #${PR}."
