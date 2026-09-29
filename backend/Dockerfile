# ============================================================================
# Stage 1 — builder
# Full Node toolchain (devDependencies incl. tsc + prisma CLI) compiles the
# TypeScript and generates the Prisma client. Discarded from the final image.
# ============================================================================
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /app

# Copy the prisma directory up front so that (a) any future postinstall
# hook from @prisma/client sees the schema, and (b) the prebuild script
# `prisma generate` fired by `npm run build` below can find it. Doing
# the layout this way means the only required write is the generated
# client under src/generated/prisma, which is already covered by the
# later `COPY src ./src` step below + the runner-stage copy.
COPY package*.json ./
COPY prisma ./prisma

RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY prisma.config.ts ./
COPY src ./src

RUN npm run build

# ============================================================================
# Stage 2 — production runner
# Minimal Alpine base, production-only dependencies, non-root `node` user.
# ============================================================================
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runner

WORKDIR /app

ENV NODE_ENV=production

# Order matters here for layer caching: COPY package*.json + npm install
# stay pinned together so that pure source-only changes do NOT invalidate
# the dependency install. --ignore-scripts skips the @prisma/client
# postinstall (we already COPY the generated client from the builder
# below), so the runner never needs the schema to install dependencies.
# The npm cache is purged in the same layer so it never ships in the image.
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# Copy the prisma schema into the runner. The boot-and-check-health step
# in .github/workflows/ci.yml runs `npx prisma db push` against this
# container; without prisma/schema.prisma on disk, that command errors
# out and the 60-iteration /health poll times the job out.
COPY prisma ./prisma

COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/src/generated ./dist/generated
COPY --chown=node:node prisma.config.ts ./

# Drop root privileges for the running process. The `node` user (uid 1000)
# ships with the node:20-alpine base image — no extra user needs creating.
USER node

EXPOSE 3001

# Native healthcheck so Docker Compose / Kubernetes can gate traffic on
# readiness instead of only checking that the process is running.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3001/health || exit 1

# Exec node directly instead of `npm start` so the server runs as PID 1 and
# receives SIGTERM/SIGINT for the graceful-shutdown handler in src/index.ts.
CMD ["node", "dist/index.js"]
