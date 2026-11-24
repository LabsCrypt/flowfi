# ============================================================================
# Stage 1 — builder
# Installs the npm workspace from the repo root, then runs `next build`, which
# emits a self-contained server bundle (`output: "standalone"` in
# frontend/next.config.ts) instead of the full `.next` tree + node_modules.
# ============================================================================
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS builder

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

# `npm ci` only: a lockfile/package.json desync must fail the build visibly
# rather than silently resolving different versions. Drift is also checked
# separately in CI (see the "Verify lockfile is in sync" step in ci.yml).
RUN npm ci --no-audit --no-fund

COPY frontend ./frontend

RUN npm run build --workspace frontend

# ============================================================================
# Stage 2 — production runner
# Copies only the traced standalone output (never the workspace node_modules)
# and runs as the non-root `node` user that ships with the Alpine base image.
# ============================================================================
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a AS runner

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
# node-based check: the runtime image only ships busybox wget, which rejects
# GNU flags such as --no-verbose/--tries.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))" || exit 1

CMD ["node", "frontend/server.js"]
