# ============================================================
# Stage 1: builder — full Node toolchain to compile TypeScript
# ============================================================
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

# Install all deps (incl. devDependencies needed for tsc / prisma generate)
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.json ./
COPY prisma.config.ts ./
COPY src ./src

RUN npm run build

# ============================================================
# Stage 2: production runner — minimal Alpine image, non-root
# ============================================================
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runner

# Security: drop to non-root user for the running process
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs nodeapp

WORKDIR /app

ENV NODE_ENV=production

# Order matters here for layer caching: COPY package*.json + npm install
# stay pinned together so that pure source-only changes do NOT invalidate
# the dependency install. --ignore-scripts skips the @prisma/client
# postinstall (we already COPY the generated client from the builder
# below), so the runner never needs the schema to install dependencies.
# The schema is then copied AFTER install so it is on disk for the
# `npx prisma db push` step the workflow runs against this container,
# while keeping the install layer cached whenever prisma/ is unchanged.
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts; else npm install --omit=dev --ignore-scripts; fi

# Copy the prisma schema into the runner. The boot-and-check-health step
# in .github/workflows/ci.yml runs `npx prisma db push` against this
# container; without prisma/schema.prisma on disk, that command errors
# out and the 60-iteration /health poll times the job out.
COPY prisma ./prisma

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/generated ./dist/generated
COPY --from=builder /app/prisma ./prisma
COPY prisma.config.ts ./

# Ownership hand-off — ensure the non-root user owns all app files
RUN chown -R nodeapp:nodejs /app

USER nodeapp

EXPOSE 3001

# Health check so orchestrators (Docker Compose / Kubernetes) can detect
# when the API is ready to serve traffic.
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

CMD ["npm", "start"]