FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/database.sqlite \
    UPLOAD_DIR=/app/data/uploads
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /app/data/uploads && chown -R node:node /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node public ./public

USER node
CMD ["node", "dist/server.js"]
