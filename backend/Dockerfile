FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY prisma ./prisma

RUN npm run build

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/generated ./dist/generated
COPY --from=builder /app/prisma ./prisma
# Prisma 7 reads the schema location and datasource url from prisma.config.ts,
# and the schema's `datasource db {}` block has no inline url. The CI health
# check runs `prisma db push` inside this image, so the config must be present
# too (dotenv is a runtime dependency, so the config loads).
COPY prisma.config.ts ./

EXPOSE 3001

CMD ["npm", "start"]