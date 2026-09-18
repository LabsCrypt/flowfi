# ============================================================
# Stage 1: deps — install production-only dependencies
# ============================================================
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS deps

WORKDIR /app

# Copy lockfile first for optimal Docker layer caching:
# rebuilds only when package files change, not source files.
COPY package*.json ./
RUN npm ci --omit=dev

# ============================================================
# Stage 2: builder — compile Next.js application
# ============================================================
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

# Copy source files
COPY . .

# Build the Next.js application (output: .next directory)
RUN npm run build

# ============================================================
# Stage 3: production runner — minimal Alpine image, non-root
# ============================================================
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runner

# Security: run as non-root user
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs nextapp

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

# Copy only what is needed to run the app
COPY --from=deps    /app/node_modules ./node_modules
COPY --from=builder /app/.next        ./.next
COPY --from=builder /app/public       ./public
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/next.config.ts ./

# Ownership hand-off — ensure the non-root user owns all app files
RUN chown -R nextapp:nodejs /app

USER nextapp

EXPOSE 3000

# Health check so orchestrators know when Next.js is ready to serve
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["npm", "start"]
