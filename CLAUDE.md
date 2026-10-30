# CLAUDE.md

Este arquivo orienta o Claude Code ao trabalhar neste repositório.

## Visão geral

RAG Local: aplicação de RAG com notebooks independentes. Backend Express 5 + TypeScript (ESM), SQLite via `node:sqlite` (Node >= 22.13, sem dependências nativas para o banco) e frontend estático em `public/` (JS puro, sem build). Os provedores de IA (Ollama, OpenAI e compatíveis, Gemini, Anthropic) são cadastrados na tela de Configurações, não no ambiente.

## Comandos

```bash
npm install
npm run dev        # tsx watch em src/server.ts (http://localhost:3000)
npm run typecheck  # tsc --noEmit
npm test           # testes determinísticos (sem LLM): chunking, registros, filtros, cálculos
npm run bench -- --label nova --out bench.json   # benchmark ponta a ponta com Ollama (qwen2.5:1.5b + bge-m3)
npm run build      # tsc -> dist/
npm start          # node dist/server.js
docker compose up -d --build   # sobe app + Ollama + modelos (OLLAMA_*); dados em ./data
```

Valide com `npm run typecheck` e `npm test`. O benchmark usa `tests/fixtures/Base_RAG_Verdanis.md` e o gabarito `tests/fixtures/bench_questions.json`; `--src <dir>` mede outra cópia do código.

## Estrutura

- [src/server.ts](src/server.ts): rotas da API, upload (multer), autenticação, apresentação pública (`/api/present/:id/ask`, NDJSON em streaming).
- [src/chunking.ts](src/chunking.ts): chunking estrutural (seções no prefixo `[Seção: …]`, tabelas por grupos de linhas com cabeçalho repetido, listas inteiras).
- [src/structured.ts](src/structured.ts): registros de tabelas/fichas (`records`), interpretação da pergunta (`analyzeQuery`) e respostas determinísticas (filtros, contagem, soma, média, ordenação, listagem completa) e registros exatos por código.
- [src/rag.ts](src/rag.ts): busca híbrida (semântica + BM25-like com RRF), `modelProfile` (topK, contexto, max tokens por tamanho de modelo), construção do prompt e `ask`.
- [src/ai.ts](src/ai.ts): abstração dos provedores (chat em streaming, embeddings, listagem de modelos, testes). Opções do Ollama (`num_ctx`, `num_predict`, `num_thread`) ficam aqui.
- [src/documents.ts](src/documents.ts): extração de texto (PDF, DOCX, PPTX, XLSX, imagens com OCR…), indexação e reindexação.
- [src/database.ts](src/database.ts): schema SQLite (notebooks, documents, chunks, conversations, messages, saved_messages, provedores).
- [src/auth.ts](src/auth.ts): login com usuário mestre + JWT em cookie, rate limit.
- [public/](public/): `app.js` (UI principal, minificado em poucas linhas), `settings.js`, `login.html`, `present.html`.
- [docker/start.mjs](docker/start.mjs): entrypoint do container.

## Convenções

- Código denso, comentários em português, mensagens ao usuário em português. Siga o estilo existente (arrow functions, declarações compactas).
- Imports internos usam extensão `.js` (ESM com `tsc`).
- Configuração via variáveis de ambiente listadas em [.env.example](.env.example) e documentadas no [README.md](README.md); mantenha os três (código, `.env.example`, `docker-compose.yml`) sincronizados ao adicionar variáveis.
- `documents.chunk_version` marca o chunking usado (1 = estrutural); documentos antigos continuam funcionando e são atualizados com "Reprocessar". `backfillRecords` extrai registros dos documentos antigos na inicialização sem recalcular embeddings.
- Trocar o modelo de embeddings exige reindexar; a busca retorna `incompatible` se os vetores divergirem.
- O Ollama recarrega o modelo quando `num_ctx` muda entre chamadas: todas as chamadas de chat usam `chatContext()` para o mesmo valor.

## Ajuste de desempenho (modelos pequenos/CPU)

`modelProfile` em `src/rag.ts` deriva o perfil do tamanho no nome do modelo (`mini` < 1B, `pequeno` < 2,5B, `médio` < 10B, `grande`). Perfis mini/pequeno usam topK 2–3, `num_ctx` 2048, `num_predict` 150, temperatura 0 e sem chunks vizinhos. Sobrescritas por ambiente: `RETRIEVAL_TOP_K`, `MAX_CONTEXT_CHARS`, `CHAT_MAX_TOKENS`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `OLLAMA_NUM_THREAD`, `QUERY_EXPANSION` (desligado por padrão: custa uma geração extra).

## Cuidados

- Segredos (`MASTER_PASSWORD`, `JWT_SECRET`, chaves de API) nunca devem ser commitados; `./data` guarda banco e uploads.
- Conteúdo de documentos é tratado como dados, não instruções, no prompt de sistema; preserve essa regra ao alterar prompts.
