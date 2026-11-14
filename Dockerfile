# syntax=docker/dockerfile:1
# Estágios: deps (dependências completas) → build (tsc) → test (testes via compose --profile test) → runtime (produção).
FROM node:22.23.3-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Testes unitários e de integração reais (Qdrant da rede interna + Ollama do Windows). Ver README, "Testes".
FROM deps AS test
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
USER node
CMD ["npm", "test"]

FROM node:22.23.3-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    SQLITE_PATH=/app/volumes/sqlite/database.db \
    APP_DATA_DIR=/app/volumes/app
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
 && mkdir -p /app/volumes/sqlite /app/volumes/app && chown -R node:node /app/volumes
# Código pertence ao root (somente leitura para o processo); o usuário node só escreve nos volumes.
COPY --from=build /app/dist ./dist
COPY public ./public
COPY docker ./docker
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz?live=1').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "docker/start.mjs"]
