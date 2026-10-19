# ============================================================================
# Stage 1 — builder
# Installs the npm workspace from the repo root, then runs `next build`, which
# emits a self-contained server bundle (`output: "standalone"` in
# frontend/next.config.ts) instead of the full `.next` tree + node_modules.
# ============================================================================
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /app

# NEXT_PUBLIC_* values are inlined into the client bundle at build time, so
# they must be passed as build args (runtime env has no effect on them).
# Defaults target the local Docker Compose stack; override with `--build-arg`
# for a real deployment.
ARG NEXT_PUBLIC_API_URL=http://localhost:3001/v1
ARG NEXT_PUBLIC_STELLAR_NETWORK=TESTNET
ARG NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
ARG NEXT_PUBLIC_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_STELLAR_NETWORK=$NEXT_PUBLIC_STELLAR_NETWORK \
    NEXT_PUBLIC_SOROBAN_RPC_URL=$NEXT_PUBLIC_SOROBAN_RPC_URL \
    NEXT_PUBLIC_NETWORK_PASSPHRASE=$NEXT_PUBLIC_NETWORK_PASSPHRASE

# Copy the workspace manifests first so the (slow) dependency layer stays
# cached until a package.json or the root lockfile actually changes.
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
COPY backend/package.json ./backend/

# `npm ci` is the reproducible path; fall back to `npm install` when the
# committed lockfile and package.json are out of sync so the image still
# builds (dependency drift is tracked separately from this issue).
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY frontend ./frontend

RUN npm run build --workspace frontend

# ============================================================================
# Stage 2 — production runner
# Copies only the traced standalone output (never the workspace node_modules)
# and runs as the non-root `node` user that ships with the Alpine base image.
# ============================================================================
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# The standalone bundle mirrors the monorepo layout, so the entrypoint is
# `frontend/server.js` and that prefix must be preserved. `.next/static` and
# `public/` are not part of the standalone output and are copied explicitly.
COPY --from=builder --chown=node:node /app/frontend/.next/standalone ./
COPY --from=builder --chown=node:node /app/frontend/.next/static ./frontend/.next/static
COPY --from=builder --chown=node:node /app/frontend/public ./frontend/public

USER node

EXPOSE 3000

# Native healthcheck against the app's own /health route handler so Compose /
# Kubernetes can gate traffic on readiness, not just process liveness.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1

CMD ["node", "frontend/server.js"]
