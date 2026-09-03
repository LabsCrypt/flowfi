FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
RUN npm install

COPY tsconfig.json ./
COPY prisma.config.ts ./
COPY src ./src
RUN npm run build

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS runner
WORKDIR /app
ENV NODE_ENV=production

# /app is created by root via WORKDIR. Give node ownership of the
# directory itself (cheap metadata change, empty dir) BEFORE switching
# users, so npm can create node_modules without a permission error.
RUN chown node:node /app

COPY --chown=node:node package*.json ./

USER node

RUN npm install --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node prisma ./prisma
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/src/generated ./dist/generated
COPY --chown=node:node prisma.config.ts ./

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "const http=require('http');const req=http.request({host:'127.0.0.1',port:3001,path:'/health',method:'GET',timeout:2000},res=>{process.exit(res.statusCode===200?0:1)});req.on('error',()=>process.exit(1));req.end();"

EXPOSE 3001
CMD ["npm", "start"]
