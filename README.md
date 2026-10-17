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
ollama pull nomic-embed-text
```

Copie `.env.example` para `.env` (no Windows: `copy .env.example .env`) e ajuste se necessário. Os modelos não são baixados pela aplicação. Inicie com:

```bash
npm run dev
```

Acesse http://localhost:3000. Para verificar a compilação TypeScript: `npm run typecheck`. Para gerar a versão de produção e executá-la localmente: `npm run build` e `npm start`.

### Docker Compose

O Compose não inicia Ollama e não publica portas. Os dados persistem em `./data` e o serviço entra na rede Docker `app_net`:

```bash
docker compose up -d --build
```

Configure `OLLAMA_BASE_URL` no ambiente ou em `.env` se necessário. O padrão `http://host.docker.internal:11434` funciona no Docker Desktop; no Linux, o Compose mapeia esse nome para o host, mas o Ollama precisa aceitar conexões vindas do Docker (por exemplo, escutar em `0.0.0.0:11434` e permitir a conexão no firewall). A aplicação não tem porta publicada pelo Compose; para acessá-la, conecte um proxy/serviço à rede `app_net`.

## Configuração

`OLLAMA_BASE_URL`, `OLLAMA_CHAT_MODEL`, `OLLAMA_EMBEDDING_MODEL`, `DATABASE_PATH`, `UPLOAD_DIR`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `RETRIEVAL_TOP_K`, `MAX_CONTEXT_CHARS`, `OLLAMA_NUM_CTX`, `OLLAMA_NUM_PREDICT` e `OLLAMA_KEEP_ALIVE` são lidos do ambiente. Para servidor limitado, comece com `CHUNK_SIZE=700`, `CHUNK_OVERLAP=100`, `RETRIEVAL_TOP_K=4`, `MAX_CONTEXT_CHARS=7000`, `OLLAMA_NUM_CTX=4096`, `OLLAMA_NUM_PREDICT=384` e `OLLAMA_KEEP_ALIVE=5m`. Menos contexto/resposta reduz RAM e latência; se a resposta perder evidências, aumente `MAX_CONTEXT_CHARS`/`RETRIEVAL_TOP_K`. Use sempre o mesmo modelo de embeddings para indexar e consultar; se alterá-lo ou trocar sua dimensão, reprocesse os documentos. Diretórios e banco são criados localmente. Para trocar as configurações, pare o servidor antes de copiar/editar `.env`.

## Uso

Crie um notebook, adicione arquivos compatíveis (PDF, DOCX, XLSX/XLS, CSV, TXT e Markdown) ou texto colado e aguarde o estado `processed`. Documentos com erro podem ser reprocessados pela interface. Abra uma conversa e pergunte; a resposta inclui trechos-fontes recuperados. Conversas, documentos e vetores permanecem após reiniciar o servidor. Excluir documento remove seus chunks/vetores e tenta remover o arquivo original; excluir notebook remove seus dados associados.

## API

- `GET/POST /api/notebooks`, `PATCH/DELETE /api/notebooks/:id`
- `GET /api/notebooks/:id/documents`, `POST /api/notebooks/:id/documents` (multipart `file`), `POST /api/notebooks/:id/text`
- `POST /api/documents/:id/reprocess`, `DELETE /api/documents/:id`
- `GET/POST /api/notebooks/:id/conversations`
- `GET /api/conversations/:id/messages`, `POST /api/conversations/:id/messages` (`content`)
- `GET /api/health/ollama`

## Notas

PDFs escaneados (imagem sem camada textual) precisam de OCR, não incluído. O limite de upload é 30 MB por arquivo. Cada documento é indexado individualmente e cada busca consulta somente o notebook ativo; a conversa não injeta o histórico inteiro ao modelo, limitando o contexto para proteger máquinas modestas. O endpoint Ollama `/api/embed` requer uma versão atual do Ollama. Docker não é obrigatório: Node.js 22.13+ e Ollama podem rodar diretamente no servidor.
