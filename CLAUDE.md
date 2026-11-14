# CLAUDE.md

Este arquivo orienta o Claude Code ao trabalhar neste repositório.

## Visão geral

Bento (antes "RAG Local"): aplicação de RAG com notebooks independentes. Backend Express 5 + TypeScript (ESM) e frontend estático em `public/` (JS puro, sem build). Três peças com responsabilidades separadas:
- **Qdrant** (container, rede interna do Compose): vetores densos + esparsos BM25, busca híbrida, quantização INT8. Cliente REST próprio em `src/qdrant.ts` (sem SDK).
- **SQLite** (`node:sqlite`, Node >= 22.13): fonte de verdade de textos, metadados, conversas e estado de indexação. **Nunca** guarda embeddings nem calcula similaridade.
- **Ollama no Windows 11** (fora do Docker): LLM (`OLLAMA_LLM_MODEL`) e embeddings (`OLLAMA_EMBEDDING_MODEL`). Nunca adicionar Ollama ao Compose nem baixar modelos automaticamente. Não adicionar integrações com OpenAI, Gemini, Anthropic/Claude ou outros provedores.

Execução **só via Docker Compose no WSL2** (sem execução nativa com Node.js). O Ollama do Windows é alcançado pelo IP do Windows visto pelo WSL2, via `scripts/windows/ollama-wsl-bridge.ps1` (portproxy restrito à interface do WSL; o Ollama segue em 127.0.0.1).

## Comandos (no WSL2, na pasta do projeto)

```bash
docker compose up -d --build                                              # app + Qdrant; volumes em ${VOLUMES_DIR:-./volumes}
docker compose logs -f rag
docker compose --profile test run --rm --no-deps tests npm run test:unit  # determinísticos (sem LLM/Qdrant)
docker compose --profile test run --rm tests npm run test:integration      # integração real: Qdrant + Ollama do Windows
docker compose --profile test run --rm tests npm run typecheck
docker compose --profile test run --rm tests npm run bench -- --label nova # benchmark ponta a ponta (collection temporária)
bash scripts/e2e.sh                                                         # API HTTP da aplicação no ar + reinício dos containers
```

Valide com typecheck, testes unitários e de integração (todos no container `tests`). O benchmark usa `tests/fixtures/Base_RAG_Verdanis.md` e o gabarito `tests/fixtures/bench_questions.json`; `--src <dir>` mede outra cópia do código. Volumes do Qdrant/SQLite precisam de disco Linux (ext4): com o projeto em `/mnt/c`, use `VOLUMES_DIR` no `.env`.

## Estrutura

- [src/server.ts](src/server.ts): rotas da API, upload (multer), autenticação, chat incorporável via iframe (`/api/present/:id/ask`, NDJSON em streaming).
- [src/chunking.ts](src/chunking.ts): chunking estrutural (seções no prefixo `[Seção: …]`, tabelas por grupos de linhas com cabeçalho repetido, listas inteiras). `cleanPdfPages` limpa o texto do PDF por página (cabeçalho/rodapé repetido nas bordas e ausente do miolo, números de página, sumário com pontilhado; títulos numerados viram `#`); `isTocChunk` marca trechos de sumário, que a busca ignora. Testes em `tests/pdfclean.test.mts`.
- [src/structured.ts](src/structured.ts): registros de tabelas/fichas (`records`), interpretação da pergunta (`analyzeQuery`) e respostas determinísticas (filtros, contagem, soma, média, ordenação, listagem completa) e registros exatos por código.
- [src/rag.ts](src/rag.ts): busca híbrida (`hybridSearch`: candidatos do Qdrant → textos em lote do SQLite → RRF ponderado, códigos exatos, portão por z-score com a amostra do notebook → reranking dos 25 primeiros), construção do prompt por perfil e `ask`.
- [src/rerank.ts](src/rerank.ts): reranking local com Cross-Encoder ONNX em CPU (`@huggingface/transformers` 4.3.2 + onnxruntime-node; padrão `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` int8, multilíngue, ~1 s/25 trechos em lotes de 4, +~380 MB de RAM). Baixado do Hugging Face na inicialização (`prepareReranker`) para `APP_DATA_DIR/reranker`; enquanto não está pronto ou se falhar, `rerankScores` devolve `null` e a busca usa a ordem/corte antigos. `rerankOrder`: código exato na frente, depois a pontuação do Cross-Encoder. Top-N: 4 nos compactos (qwen3:1.7b), top-K do perfil (mín. 4) nos maiores; `RERANK_*` sobrescreve. O Dockerfile usa `ONNXRUNTIME_NODE_INSTALL=skip` (sem download de CUDA no `npm ci`) e remove os binários de outras plataformas. Testes em `tests/rerank.test.mts`.
- [src/indexing.ts](src/indexing.ts): sincronização SQLite ↔ Qdrant. IDs determinísticos (`chunkPointId`), fila por documento (`enqueue`), `ensureCollection` (cria; só recria/apaga com `allowRecreate` em indexação), `indexDocument` (retomável por `chunks.indexed`), mensagens salvas, exclusões com `vector_deletions`, `searchCandidates` (uma chamada `query/batch`: densa, esparsa, por código e amostra) e `reconcile` (órfãos, divergências por facet, retomada, reconstrução).
- [src/qdrant.ts](src/qdrant.ts): cliente REST e configuração da collection (dense Cosine on_disk, sparse `bm25` com IDF, INT8, `m: 0`/`payload_m: 16`, índices de payload). [src/sparse.ts](src/sparse.ts): tokenização/stemming e vetores esparsos BM25. [src/config.ts](src/config.ts): variáveis de infraestrutura e `validateConfig`.
- [src/modelprofile.ts](src/modelprofile.ts): reconhecimento do modelo (tamanho, família, contexto, raciocínio) e perfil de geração e recuperação derivado dele; prefixos de embeddings.
- [src/ai.ts](src/ai.ts): cliente do Ollama (chat em streaming, embeddings, listagem de modelos, testes). Opções do Ollama (`num_ctx`, `num_predict`, `num_thread`) ficam aqui; `num_thread` vem de `tunedThreads` (tuning.ts).
- [src/tuning.ts](src/tuning.ts): ajuste automático ao PC, antes do `app.listen` (server.ts): detecta CPU/RAM/GPU, mede no Ollama as threads mais rápidas para o modelo ativo (pula se o modelo está todo na GPU), guarda em `APP_DATA_DIR/tuning.json` (chave: hardware + servidor + versão do Ollama + modelo), pré-carrega embeddings e chat com o mesmo `num_ctx`/`num_thread` das perguntas e avisa no log sobre GPU ociosa ou `OLLAMA_MAX_LOADED_MODELS=1`. `OLLAMA_NUM_THREAD` sobrescreve; `AUTOTUNE=false` desliga. Não mexe em `num_ctx` (medido: não muda a velocidade, só a memória). Testes em `tests/tuning.test.mts`.
- [src/documents.ts](src/documents.ts): extração de texto (PDF, DOCX, PPTX, XLSX, imagens com OCR…), indexação e reindexação.
- [src/voice.ts](src/voice.ts): modo de voz local com `sherpa-onnx-node` (versão fixa 1.13.8: a 2.x removeu o espeak-ng usado pelas vozes Piper). STT Parakeet/Whisper, TTS Piper, correção de códigos do notebook na transcrição (`fixCodes`, usa `extractCodes` do RAG só para leitura), download sob demanda do Hugging Face para `VOICE_DIR` (`APP_DATA_DIR/voice`) (marcadores `.ok-*`), filas por modelo, limpeza (`speechText`) e normalização pt-BR (`normalizePt`) do texto falado; rotas em `/api/voice`. Não toca no RAG: a pergunta transcrita vai pela rota de mensagens. [public/voice.js](public/voice.js): overlay em tela cheia (HUD em canvas), VAD por energia no navegador, frases enviadas à síntese conforme o streaming chega, efeitos via Web Audio. Testes em `tests/voice.test.mts`.
- [src/database.ts](src/database.ts): schema SQLite (notebooks, documents com `stage`/`embedding_model`, chunks com `indexed`/páginas/`toc`, conversations, messages, saved_messages, records, vector_deletions; provedores e settings em ai.ts). Bancos antigos com embeddings em BLOB são recusados.
- [src/auth.ts](src/auth.ts): login com usuário mestre + JWT em cookie, rate limit.
- [public/](public/): `app.js` (UI principal, minificado em poucas linhas), `settings.js`, `login.html`, `embed.html`. Cores e fonte seguem o Jabil Brand Guidelines: paleta em variáveis CSS `--c-*` (claro/escuro) e no `tailwind.config` de `theme.js` (compartilhado por `index.html` e `login.html`; liberado sem login em `openPages`; o tema escolhido fica em `localStorage` `bento-theme`; use tokens como `bg-surface`, `text-heading`, `text-ok-ink`, não cores fixas) e componentes (`.btn`, `.panel`, `.msg`…) em `index.html`. Abaixo de 1280px o notebook usa abas (Conversa/Documentos/Histórico); a partir de 1280px as colunas Documentos e Conversas são recolhíveis (estado em `localStorage` `bento-cols`, animação por variáveis `--lw`/`--rw` em `#wsGrid`). O iframe (`embed.html`) tem um interruptor Rápido/Detalhado que envia `detailed` em `/api/present/:id/ask`.
- [docker/start.mjs](docker/start.mjs): entrypoint do container.

## Convenções

- Código denso, comentários em português, mensagens ao usuário em português. Siga o estilo existente (arrow functions, declarações compactas).
- Imports internos usam extensão `.js` (ESM com `tsc`).
- Configuração via variáveis de ambiente listadas em [.env.example](.env.example) e documentadas no [README.md](README.md); mantenha os três (código, `.env.example`, `docker-compose.yml`) sincronizados ao adicionar variáveis.
- `documents.chunk_version` marca o chunking usado (2 = PDF limpo e nome do documento no texto do embedding, `embeddingInput`; 3 = páginas de origem do PDF e vetores no Qdrant). `backfillRecords` extrai registros dos documentos antigos na inicialização sem recalcular embeddings.
- Ingestão em duas fases: trechos no SQLite numa transação (`stage='index'`), depois lotes no Qdrant (`indexed=1` por lote) e só então `processed`. Toda escrita no Qdrant usa os IDs do SQLite; nunca gere IDs aleatórios para pontos. Exclusões: SQLite primeiro, depois Qdrant (`deleteDocumentVectors`/`deleteNotebookVectors`/`deletePointVectors`).
- O payload do Qdrant não leva o texto; textos e metadados sempre vêm do SQLite. Toda busca filtra por `notebook_id`.
- Trocar o modelo de embeddings exige "Reindexar"; `ask` responde pedindo reindexação se `settings.vector_model` ou `documents.embedding_model` divergirem do modelo ativo (nunca recria a collection numa pergunta).
- O Ollama recarrega o modelo quando `num_ctx` muda entre chamadas: todas as chamadas de chat usam `chatContext()` para o mesmo valor.

## Ajuste automático por modelo (modelos locais, CPU)

O RAG reconhece o modelo de chat ativo e deriva o perfil de uso dele ([src/modelprofile.ts](src/modelprofile.ts), `deriveProfile`), sem depender de um modelo específico. Tamanho, contexto nativo e capacidades vêm do Ollama (`/api/show`, em cache em `refreshModelInfo`) ou, se indisponível, do nome. Faixas de tamanho: `mini` < 1B, `pequeno` < 2,5B, `médio` < 6B, `grande` < 14B, `avançado`. Mini/pequeno usam prompt mínimo, topK 2–3 (4 trechos com o reranking), `num_ctx` 3072, `num_predict` 400, sem vizinhos nem turnos anteriores no prompt; do médio em diante, prompt com regras, mais contexto/topK e turnos anteriores (só em perguntas de acompanhamento, sem recusas). Memória da conversa (`resolveFollowUp` em rag.ts, todos os tamanhos): o servidor sempre manda as últimas 8 mensagens; perguntas de acompanhamento são resolvidas antes da busca herdando códigos da pergunta anterior já resolvida ou da última resposta (1–2 códigos), sem LLM; reescrita pelo LLM só do 3B em diante e só sem pista determinística, validada pelos códigos. Consultas de conjunto (listas, contagens, filtros) não herdam códigos. O benchmark tem a categoria `seguimento` (campo `prev`) e `tests/memory.test.mts` cobre a resolução. A família (qwen3, qwen2, llama, gemma, phi, mistral) ajusta `top_p`, `top_k` e a penalidade de repetição; o contexto nunca passa do nativo do modelo; modelos que só raciocinam (`*-thinking`, DeepSeek-R1, gpt-oss) não recebem `think: false`, ganham folga de saída. Não há verificação de escopo separada: o próprio modelo decide se responde ou recusa (regra de recusa do prompt); se a busca estrita não achar nada, `ask` tenta a pergunta original e depois uma busca relaxada (`hybridSearch(..., relaxed)`) com até 3 trechos. Modelos de embeddings com prefixo de consulta/documento (nomic, e5, mxbai, snowflake-arctic, qwen3-embedding, embeddinggemma) são tratados em `embeddingPrefix`. Sobrescritas por ambiente: `RETRIEVAL_TOP_K`, `MAX_CONTEXT_CHARS`, `CHAT_MAX_TOKENS`, `NEIGHBOR_EXPAND_TOP`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `OLLAMA_NUM_THREAD`. O botão Testar da tela de Configurações mostra o perfil detectado.

## Cuidados

- Segredos (`MASTER_PASSWORD`, `JWT_SECRET`, `QDRANT_API_KEY`, chaves de API) nunca devem ser commitados; os volumes (`VOLUMES_DIR`) guardam Qdrant, SQLite e uploads. O Qdrant não publica portas; não exponha o Ollama com `OLLAMA_HOST=0.0.0.0`.
- Conteúdo de documentos é tratado como dados, não instruções, no prompt de sistema; preserve essa regra ao alterar prompts.
