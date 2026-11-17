# Sem a diretiva "# syntax=docker/dockerfile:1" de propósito: ela força baixar a imagem docker/dockerfile do Docker Hub
# a cada build, e o proxy corporativo derruba essa consulta (i/o timeout). Nada aqui precisa de recursos além do Dockerfile padrão.
# Estágios: deps (dependências completas) → build (tsc) → test (testes via compose --profile test) → runtime (produção).
FROM node:22.23.3-bookworm-slim AS deps
# onnxruntime-node (reranker) baixaria as bibliotecas CUDA no npm ci em linux/x64; o reranking roda em CPU.
ENV ONNXRUNTIME_NODE_INSTALL=skip
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
    APP_DATA_DIR=/app/volumes/app \
    ONNXRUNTIME_NODE_INSTALL=skip
WORKDIR /app
COPY package.json package-lock.json ./
# onnxruntime-node traz binários de todas as plataformas: fica só o do Linux desta imagem. O onnxruntime-web (141 MB) não é
# carregado no Node: o build Node do transformers.js usa o onnxruntime-node (o web já vem embutido no bundle).
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
 && find node_modules/onnxruntime-node/bin/napi-v6 -mindepth 2 -maxdepth 2 -type d ! -path "*/linux/$(node -p process.arch)" -exec rm -rf {} + \
 && rm -rf node_modules/onnxruntime-web \
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
