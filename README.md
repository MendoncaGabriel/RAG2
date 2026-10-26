# RAG Local

Aplicação local de RAG com notebooks independentes, Express/TypeScript, SQLite e Ollama. Usa o módulo SQLite integrado ao Node.js (`node:sqlite`, Node 22.13+), evitando dependências nativas para o banco. A recuperação é semântica: embeddings persistidos como vetores Float32 no SQLite e similaridade de cosseno calculada localmente em JavaScript, filtrando estritamente pelo notebook selecionado. Isso evita dependências nativas adicionais (`sqlite-vec`). A busca é exata e linear, adequada a bases locais pequenas e médias.

## Requisitos

- Node.js 22.13 ou superior e npm.
- Ollama instalado e em execução (`ollama serve`, se não iniciar como serviço).
- Espaço em disco para o SQLite e arquivos enviados.

## Instalação e execução

```bash
npm install
ollama pull qwen2.5:1.5b-instruct
ollama pull bge-m3
```

Copie `.env.example` para `.env` (no Windows: `copy .env.example .env`) e ajuste se necessário. Os modelos não são baixados pela aplicação. Inicie com:

```bash
npm run dev
```

Acesse http://localhost:3000. Para verificar a compilação TypeScript: `npm run typecheck`. Para gerar a versão de produção e executá-la localmente: `npm run build` e `npm start`.

### Docker Compose

O app roda em Docker e usa o **Ollama já instalado no host** (o Compose não sobe Ollama). Um comando:

```bash
# Windows / macOS (Docker Desktop)
docker compose up -d --build

# Servidor Linux (Ollama escutando só em 127.0.0.1, o padrão)
docker compose -f docker-compose.yml -f docker-compose.linux.yml up -d --build
```

Acesse http://localhost:3000. Ao iniciar, o container localiza o Ollama do host e baixa os modelos configurados que estiverem faltando (`OLLAMA_AUTO_PULL=false` desativa). Dados (SQLite, uploads, OCR) ficam no volume `rag_data`. Configurações vêm de variáveis de ambiente ou de um `.env` ao lado do compose (veja `.env.example`). Logs: `docker compose logs -f rag`. Para parar: `docker compose down` (os dados permanecem).

No Linux, em vez do arquivo extra, também funciona iniciar o Ollama com `OLLAMA_HOST=0.0.0.0` e usar só o primeiro comando. O arquivo `docker-compose.linux.yml` exige Docker Compose 2.24+.

## Configuração

`OLLAMA_BASE_URL`, `OLLAMA_CHAT_MODEL`, `OLLAMA_EMBEDDING_MODEL`, `DATABASE_PATH`, `UPLOAD_DIR`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `RETRIEVAL_TOP_K`, `MIN_RELEVANCE_SCORE`, `MAX_CONTEXT_CHARS`, `OLLAMA_NUM_CTX`, `OLLAMA_NUM_PREDICT`, `OLLAMA_KEEP_ALIVE` e `DOCUMENT_PROCESS_CONCURRENCY` são lidos do ambiente. O modelo de embeddings padrão é `bge-m3`, que permite recuperação multilíngue entre português e inglês. Para servidor limitado, comece com `CHUNK_SIZE=700`, `CHUNK_OVERLAP=100`, `RETRIEVAL_TOP_K=4`, `MIN_RELEVANCE_SCORE=0.18`, `MAX_CONTEXT_CHARS=7000`, `OLLAMA_NUM_CTX=4096`, `OLLAMA_NUM_PREDICT=384`, `OLLAMA_KEEP_ALIVE=5m` e `DOCUMENT_PROCESS_CONCURRENCY=1`. O processamento sequencial evita cargas simultâneas de OCR/embeddings e picos de memória; pode ser elevado a `2` para mais vazão se houver memória disponível. Menos contexto/resposta reduz RAM e latência; se respostas não recuperarem evidências suficientes, reduza `MIN_RELEVANCE_SCORE` ou aumente `MAX_CONTEXT_CHARS`/`RETRIEVAL_TOP_K`. A recuperação combina similaridade semântica com correspondência de termos exatos e percorre os vetores incrementalmente para manter o uso de memória limitado. Use sempre o mesmo modelo de embeddings para indexar e consultar; trocar modelo exige reprocessar todos os documentos já indexados. Diretórios e banco são criados localmente. Para trocar as configurações, pare o servidor antes de copiar/editar `.env`.

## Uso

Crie um notebook, adicione arquivos compatíveis (PDF, DOCX, PPTX, XLSX/XLS, CSV, TXT, Markdown, JSON, código, HTML/XML e imagens PNG/JPG/WebP/BMP/TIFF) ou texto colado e aguarde o estado `processed`. É possível selecionar vários arquivos por envio (até 50), cada um de até 100 MB por padrão. Documentos com erro podem ser reprocessados pela interface. Abra uma conversa e pergunte; a primeira troca gera automaticamente um título curto para a conversa. Mensagens salvas podem ser abertas para leitura e também são indexadas como contexto do notebook; remover uma mensagem da lista de salvas não apaga a mensagem original da conversa. A resposta inclui trechos-fontes recuperados. Conversas, documentos e vetores permanecem após reiniciar o servidor. Excluir documento remove seus chunks/vetores e tenta remover o arquivo original; excluir notebook remove seus dados associados.

## API

- `GET/POST /api/notebooks`, `PATCH/DELETE /api/notebooks/:id`
- `GET /api/notebooks/:id/documents`, `POST /api/notebooks/:id/documents` (multipart `file`), `POST /api/notebooks/:id/text`
- `POST /api/documents/:id/reprocess`, `DELETE /api/documents/:id`
- `GET/POST /api/notebooks/:id/conversations`
- `GET /api/conversations/:id/messages`, `POST /api/conversations/:id/messages` (`content`)
- `GET /api/health/ollama`

## Notas

OCR local de imagens é feito com Tesseract.js, pré-processando rotação, escala, contraste e nitidez. Português e inglês são reconhecidos juntos por padrão (`OCR_LANG=por+eng`; também aceita `por` ou `eng`). A recuperação e as respostas aceitam português e inglês; o idioma da resposta acompanha o idioma da pergunta. PDFs escaneados não são convertidos automaticamente para imagens e, portanto, precisam de OCR externo ou ser enviados como imagens. Os limites podem ser ajustados por `MAX_FILE_SIZE_MB` e o máximo de arquivos por envio é 50. Cada documento é indexado individualmente e cada busca consulta somente o notebook ativo; a conversa não injeta o histórico inteiro ao modelo, limitando o contexto para proteger máquinas modestas. O endpoint Ollama `/api/embed` requer uma versão atual do Ollama. Docker não é obrigatório: Node.js 22.13+ e Ollama podem rodar diretamente no servidor.

## Otimizações para modelos leves (1.5B)

- **Streaming**: a resposta aparece token a token (`POST /api/conversations/:id/messages?stream=1`, NDJSON); sem `stream=1` o comportamento antigo é mantido.
- **Menos chamadas ao LLM**: a expansão de consulta por LLM agora é opt-in (`QUERY_EXPANSION=true`); por padrão cada pergunta faz 1 embedding + 1 geração.
- **Memória de conversa**: os últimos turnos entram no prompt, e perguntas de acompanhamento ("e quando termina a fase 1 dele?") são reescritas como perguntas autônomas antes da busca.
- **Modo resumo**: perguntas como "resuma", "visão geral" ou "principais pontos" amostram trechos de todos os documentos em vez de buscar por similaridade.
- **Precisão**: corte relativo de trechos fracos (< 80% do melhor), prompt mais curto e restritivo, `temperature=0.1` e `repeat_penalty`.
- **Velocidade**: texto normalizado pré-calculado por trecho (`chunks.search_text`, preenchido automaticamente em bases existentes) e `keep_alive=30m` também nos embeddings, evitando recarregar modelos entre embedding e chat.

## Recuperação híbrida

- **Busca híbrida**: BM25 (com stemming leve para português) + similaridade vetorial, combinadas por fusão de ranks (RRF). Nomes, siglas e códigos vêm do BM25; paráfrases vêm dos embeddings.
- **Índice em memória** por notebook, invalidado automaticamente quando documentos mudam: as perguntas deixam de reler e reprocessar o SQLite.
- **Portão de relevância**: trecho sem nenhum termo em comum com a pergunta só entra se se destacar estatisticamente dos demais (z-score). Perguntas fora do assunto dos documentos são recusadas sem gastar uma chamada ao modelo de chat.
- **Trechos vizinhos** (`NEIGHBOR_EXPAND_TOP`): os melhores resultados ganham os trechos adjacentes, e trechos contíguos viram uma passagem única, sem repetir o overlap.
- **Prefixos de embedding**: `nomic-embed-text` (`search_query:`/`search_document:`) e modelos `e5` (`query:`/`passage:`) usam os prefixos para os quais foram treinados. **Reprocesse os documentos** ao adotar esta versão com esses modelos.
- **Log de tempos** no servidor: `[RAG] busca … · 1º token … · geração …`.

### Dica de desempenho do Ollama

Por padrão o Ollama pode manter só um modelo na memória, trocando entre embedding e chat a cada pergunta (2 a 7 s perdidos). Inicie o Ollama com `OLLAMA_MAX_LOADED_MODELS=2` (no Windows, defina a variável de ambiente e reinicie o Ollama) para manter os dois carregados.
