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

O Compose não inicia Ollama e não publica portas. Os dados persistem em `./data` e o serviço entra na rede Docker `app_net`:

```bash
docker compose up -d --build
```

Configure `OLLAMA_BASE_URL` no ambiente ou em `.env` se necessário. O padrão `http://host.docker.internal:11434` funciona no Docker Desktop; no Linux, o Compose mapeia esse nome para o host, mas o Ollama precisa aceitar conexões vindas do Docker (por exemplo, escutar em `0.0.0.0:11434` e permitir a conexão no firewall). A aplicação não tem porta publicada pelo Compose; para acessá-la, conecte um proxy/serviço à rede `app_net`.

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
