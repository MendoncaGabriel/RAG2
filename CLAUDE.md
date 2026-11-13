# CLAUDE.md

Este arquivo orienta o Claude Code ao trabalhar neste repositório.

## Visão geral

Bento (antes "RAG Local"): aplicação de RAG com notebooks independentes. Backend Express 5 + TypeScript (ESM), SQLite via `node:sqlite` (Node >= 22.13, sem dependências nativas para o banco) e frontend estático em `public/` (JS puro, sem build). A IA é exclusivamente o Ollama: servidores Ollama são cadastrados na tela de Configurações, não no ambiente. Não adicionar integrações com OpenAI, Gemini, Anthropic/Claude ou outros provedores.

## Comandos

```bash
npm install
npm run dev        # tsx watch em src/server.ts (http://localhost:3000)
npm run typecheck  # tsc --noEmit
npm test           # testes determinísticos (sem LLM): chunking, registros, filtros, cálculos
npm run bench -- --label nova --out bench.json   # benchmark ponta a ponta com Ollama (qwen2.5:3b + bge-m3; use `BENCH_CHAT_MODEL` para outro modelo)
npm run build      # tsc -> dist/
npm start          # node dist/server.js
docker compose up -d --build   # sobe app + Ollama + modelos (OLLAMA_*); dados em ./data
```

Valide com `npm run typecheck` e `npm test`. O benchmark usa `tests/fixtures/Base_RAG_Verdanis.md` e o gabarito `tests/fixtures/bench_questions.json`; `--src <dir>` mede outra cópia do código.

## Estrutura

- [src/server.ts](src/server.ts): rotas da API, upload (multer), autenticação, chat incorporável via iframe (`/api/present/:id/ask`, NDJSON em streaming).
- [src/chunking.ts](src/chunking.ts): chunking estrutural (seções no prefixo `[Seção: …]`, tabelas por grupos de linhas com cabeçalho repetido, listas inteiras).
- [src/structured.ts](src/structured.ts): registros de tabelas/fichas (`records`), interpretação da pergunta (`analyzeQuery`) e respostas determinísticas (filtros, contagem, soma, média, ordenação, listagem completa) e registros exatos por código.
- [src/rag.ts](src/rag.ts): busca híbrida (semântica + BM25-like com RRF), construção do prompt por perfil e `ask`.
- [src/modelprofile.ts](src/modelprofile.ts): reconhecimento do modelo (tamanho, família, contexto, raciocínio) e perfil de geração e recuperação derivado dele; prefixos de embeddings.
- [src/ai.ts](src/ai.ts): cliente do Ollama (chat em streaming, embeddings, listagem de modelos, testes). Opções do Ollama (`num_ctx`, `num_predict`, `num_thread`) ficam aqui.
- [src/documents.ts](src/documents.ts): extração de texto (PDF, DOCX, PPTX, XLSX, imagens com OCR…), indexação e reindexação.
- [src/database.ts](src/database.ts): schema SQLite (notebooks, documents, chunks, conversations, messages, saved_messages, provedores).
- [src/auth.ts](src/auth.ts): login com usuário mestre + JWT em cookie, rate limit.
- [public/](public/): `app.js` (UI principal, minificado em poucas linhas), `settings.js`, `login.html`, `embed.html`. Cores e fonte seguem o Jabil Brand Guidelines: paleta em variáveis CSS `--c-*` (claro/escuro) e no `tailwind.config` de `theme.js` (compartilhado por `index.html` e `login.html`; liberado sem login em `openPages`; o tema escolhido fica em `localStorage` `bento-theme`; use tokens como `bg-surface`, `text-heading`, `text-ok-ink`, não cores fixas) e componentes (`.btn`, `.panel`, `.msg`…) em `index.html`. Abaixo de 1280px o notebook usa abas (Conversa/Documentos/Histórico); a partir de 1280px as colunas Documentos e Conversas são recolhíveis (estado em `localStorage` `bento-cols`, animação por variáveis `--lw`/`--rw` em `#wsGrid`). O iframe (`embed.html`) tem um interruptor Rápido/Detalhado que envia `detailed` em `/api/present/:id/ask`.
- [docker/start.mjs](docker/start.mjs): entrypoint do container.

## Convenções

- Código denso, comentários em português, mensagens ao usuário em português. Siga o estilo existente (arrow functions, declarações compactas).
- Imports internos usam extensão `.js` (ESM com `tsc`).
- Configuração via variáveis de ambiente listadas em [.env.example](.env.example) e documentadas no [README.md](README.md); mantenha os três (código, `.env.example`, `docker-compose.yml`) sincronizados ao adicionar variáveis.
- `documents.chunk_version` marca o chunking usado (1 = estrutural); documentos antigos continuam funcionando e são atualizados com "Reprocessar". `backfillRecords` extrai registros dos documentos antigos na inicialização sem recalcular embeddings.
- Trocar o modelo de embeddings exige reindexar; a busca retorna `incompatible` se os vetores divergirem.
- O Ollama recarrega o modelo quando `num_ctx` muda entre chamadas: todas as chamadas de chat usam `chatContext()` para o mesmo valor.

## Ajuste automático por modelo (modelos locais, CPU)

O RAG reconhece o modelo de chat ativo e deriva o perfil de uso dele ([src/modelprofile.ts](src/modelprofile.ts), `deriveProfile`), sem depender de um modelo específico. Tamanho, contexto nativo e capacidades vêm do Ollama (`/api/show`, em cache em `refreshModelInfo`) ou, se indisponível, do nome. Faixas de tamanho: `mini` < 1B, `pequeno` < 2,5B, `médio` < 6B, `grande` < 14B, `avançado`. Mini/pequeno usam prompt mínimo, topK 2–3, `num_ctx` 3072, `num_predict` 400, sem vizinhos nem histórico; do médio em diante, prompt com regras, mais contexto/topK e histórico. A família (qwen3, qwen2, llama, gemma, phi, mistral) ajusta `top_p`, `top_k` e a penalidade de repetição; o contexto nunca passa do nativo do modelo; modelos que só raciocinam (`*-thinking`, DeepSeek-R1, gpt-oss) não recebem `think: false`, ganham folga de saída. Não há verificação de escopo separada: o próprio modelo decide se responde ou recusa (regra de recusa do prompt); se a busca estrita não achar nada, `ask` tenta a pergunta original e depois uma busca relaxada (`hybridSearch(..., relaxed)`) com até 3 trechos. Modelos de embeddings com prefixo de consulta/documento (nomic, e5, mxbai, snowflake-arctic, qwen3-embedding, embeddinggemma) são tratados em `embeddingPrefix`. Sobrescritas por ambiente: `RETRIEVAL_TOP_K`, `MAX_CONTEXT_CHARS`, `CHAT_MAX_TOKENS`, `NEIGHBOR_EXPAND_TOP`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `OLLAMA_NUM_THREAD`. O botão Testar da tela de Configurações mostra o perfil detectado.

## Cuidados

- Segredos (`MASTER_PASSWORD`, `JWT_SECRET`, chaves de API) nunca devem ser commitados; `./data` guarda banco e uploads.
- Conteúdo de documentos é tratado como dados, não instruções, no prompt de sistema; preserve essa regra ao alterar prompts.
