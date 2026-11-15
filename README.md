# Bento

Bento é uma aplicação local de RAG com notebooks independentes (Express/TypeScript). A arquitetura separa as responsabilidades em três peças:

| Componente | Onde roda | Responsabilidade |
|---|---|---|
| **Qdrant** 1.19 | container (rede interna do Compose) | Recuperação: vetores densos (embeddings) + vetores esparsos BM25, busca híbrida, filtros por notebook/documento/código, quantização INT8 |
| **SQLite** (`node:sqlite`) | dentro do container da aplicação, arquivo em volume | Fonte de verdade: textos originais dos trechos, metadados, documentos, registros estruturados, conversas, mensagens salvas, estado de indexação |
| **Ollama** | **Windows 11** (fora do Docker) | Modelo de embeddings (`bge-m3`) e LLM (`qwen3:1.7b`) |

Tudo roda por Docker Compose no WSL2; o único serviço fora dos containers é o Ollama já instalado no Windows. Não há suporte a execução nativa com Node.js.

## Requisitos

- Windows 11 com WSL2 (Ubuntu) e Docker Engine + Compose v2 dentro do WSL2.
- Ollama instalado no Windows com os modelos configurados (`ollama pull qwen3:1.7b` e `ollama pull bge-m3`). O app **não** baixa modelos sozinho: se faltar algum, avisa qual.
- Disco Linux (ext4 do WSL) para os volumes do Qdrant e do SQLite — veja [Volumes](#volumes).

## Instalação e execução

1. **Ponte Ollama → WSL2 (uma vez, no Windows, PowerShell como Administrador):**

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\windows\ollama-wsl-bridge.ps1
   ```

   O Ollama continua escutando só em `127.0.0.1:11434`. O script cria um `portproxy` que escuta **apenas** no IP do Windows na interface virtual do WSL (ex.: `172.29.48.1`) e uma regra de firewall de entrada restrita a esse IP e à sub-rede do WSL — o Ollama não fica exposto ao Wi‑Fi/rede corporativa (não use `OLLAMA_HOST=0.0.0.0`). O script imprime a URL a usar em Configurações (ou use **Configurar automaticamente**). Se o WSL trocar de sub-rede (pode acontecer após reiniciar o Windows), rode o script de novo e atualize o `.env`; o app avisa no log e em `/healthz` quando não alcança o Ollama. `-Remove` desfaz a ponte.

2. **Configuração (no WSL2, na pasta do projeto):** `cp .env.example .env` e preencha `MASTER_PASSWORD`, `JWT_SECRET` (`openssl rand -hex 48`), e `QDRANT_API_KEY` (`openssl rand -hex 32`). **A IA não é configurada no `.env`:** depois de subir, abra **Configurações** na interface web e clique em **Configurar automaticamente** (ou cadastre o servidor manualmente; no WSL o IP do Windows sai de `ip route show default | awk '{print $3}'`).

3. **Subir / parar:**

   ```bash
   docker compose up -d --build     # http://localhost:3000 (também pelo navegador do Windows)
   docker compose logs -f rag       # logs da aplicação
   docker compose ps                # estado e healthchecks
   docker compose down              # para; os dados ficam nos volumes
   ```

Na inicialização a aplicação valida as variáveis obrigatórias, espera o Qdrant, confere o Ollama do Windows e os modelos, cria a collection se não existir e reconcilia SQLite ↔ Qdrant. `GET /healthz` mostra o estado de SQLite, Qdrant e Ollama (503 se algum falhar).

### Serviços do Compose

- `qdrant` — `qdrant/qdrant:v1.19.2-unprivileged` (uid 1000), API key obrigatória, telemetria desligada, **sem porta publicada**: só a rede interna `backend` (marcada `internal`, sem saída) o alcança; a aplicação usa `http://qdrant:6333`. Healthcheck em `/readyz`.
- `rag` — aplicação (imagem `rag-local`, usuário `node`, `cap_drop: ALL`, `no-new-privileges`). Redes `backend` (Qdrant) e `egress` (Ollama do Windows, download dos modelos de voz). Porta publicada só em `127.0.0.1` do WSL (`APP_BIND`), alcançável pelo `localhost` do Windows.
- `volumes-init` — cria as pastas dos volumes com o dono certo e termina.
- `tests` — só com `--profile test` (veja [Testes](#testes)).

### Volumes

| Pasta (`${VOLUMES_DIR:-./volumes}`) | Conteúdo |
|---|---|
| `qdrant/` | dados e snapshots do Qdrant |
| `sqlite/` | `database.db` (+ WAL) |
| `app/` | uploads originais, relatórios, dados de OCR, modelos de voz, `tuning.json` |

Importação em lote: a pasta `${IMPORT_DIR:-./import}` do host é montada **só leitura** em `/app/import`. Os arquivos dela são lidos onde estão (não são copiados para `app/`) e podem ficar em `/mnt/c`; só os bancos exigem ext4.

Os dados sobrevivem a `docker compose down/up`, reinício do Docker/WSL e reconstrução da imagem. **Qdrant e SQLite (WAL) não funcionam de forma confiável em pastas do Windows montadas no WSL (`/mnt/c`, 9p)** — o próprio Qdrant não suporta esse tipo de sistema de arquivos. Se o projeto estiver em `/mnt/c/...`, defina `VOLUMES_DIR` no `.env` para uma pasta do Linux (ex.: `/home/<usuario>/rag-volumes`); com o projeto dentro do WSL (ex.: `~/RAG2`), o padrão `./volumes` serve. A aplicação avisa no log se o SQLite estiver numa montagem 9p/drvfs.

## Arquitetura de recuperação

### Ingestão (BM25 primeiro, busca semântica em segundo plano; sem transação distribuída)

1. Extração e limpeza do texto (PDF por página, DOCX, PPTX, planilhas, OCR de imagens…) e **chunking estrutural** (abaixo).
2. **SQLite, numa transação:** trechos com **ID determinístico** (UUID derivado de documento + posição), texto original, texto normalizado, seção, páginas, marca de sumário; registros estruturados; documento em `stage='index'`.
3. **Qdrant, fase BM25** (lotes de 256, sem o Ollama): cada trecho vira um ponto só com o vetor esparso BM25 e o payload → `upsert` com `wait=true` → `indexed=2`. Pontos excedentes de uma versão anterior maior do documento são removidos. O documento já fica `processed` (`stage='dense'`): **responde perguntas pela busca por palavras + reranking** segundos depois do envio.
4. **Fase densa, em segundo plano** (um worker por processo, lotes de `EMBED_BATCH_SIZE`): embeddings no Ollama, na ordem de chegada dos documentos → atualiza só o vetor denso do ponto (`PUT /points/vectors`) → `indexed=1`. Sem pendências, o documento passa a `stage='done'`. A interface mostra "Busca semântica N/M" no cartão do documento. O worker pausa enquanto há pergunta em andamento (o Ollama atende a pergunta primeiro) e, se o Ollama ou o Qdrant cair, para e é retomado pela reconciliação.

Enquanto o vetor denso de um trecho não chega, a busca o julga só pelo lado lexical: entra se cobre ao menos metade dos termos da pergunta ou cita o código exato, e o Cross-Encoder decide a ordem. Medido com a base de teste + 1 MB de distratores (34 documentos, 1.992 trechos): tudo pesquisável em 3 s contra 322 s antes (o tempo total até a busca semântica completa é o mesmo, limitado pelo embedding no Ollama: ~6 trechos/s com bge-m3 neste PC).

Envios repetidos: o hash SHA-256 de cada arquivo fica em `documents.content_hash`; o mesmo conteúdo enviado de novo ao notebook (com qualquer nome, inclusive dentro do mesmo envio ou da importação de pasta) é ignorado e a interface avisa.

Garantias: reprocessar/reindexar sobrescreve os mesmos IDs (idempotente, sem duplicatas); se o Ollama ou o Qdrant cair no meio, os trechos já estão no SQLite e a indexação **retoma só o que falta** (na inicialização, a cada `SYNC_INTERVAL_MIN` se houver pendências, em `POST /api/system/sync` ou com "Reprocessar"). Exclusões apagam primeiro no SQLite (a busca ignora pontos sem linha no SQLite) e depois no Qdrant; se o Qdrant estiver fora, ficam em `vector_deletions` e a reconciliação conclui.

**Reconciliação** (`reconcile` em [src/indexing.ts](src/indexing.ts)): compara a contagem de pontos por documento no Qdrant (facet exato) com o SQLite, remove pontos órfãos (documentos/mensagens que não existem mais), reindexa documentos divergentes, retoma indexações interrompidas e, se a collection sumir (volume perdido), **reconstrói o índice inteiro a partir do SQLite**.

### Busca (por pergunta)

1. Pergunta normalizada (acompanhamentos viram autônomos, ver "Memória de conversa"); consultas estruturadas (filtros, somas, contagens) são respondidas direto pelos registros do SQLite.
2. Embedding da pergunta no Ollama (cache LRU de 256 consultas).
3. **Uma ida ao Qdrant** (`/points/query/batch`), sempre filtrada pelo notebook: busca **densa** (HNSW sobre INT8 + rescore com os vetores originais), busca **esparsa BM25**, busca por **código exato** (`codes` com índice de payload, quando a pergunta cita códigos) e uma **amostra aleatória** re-pontuada (média/desvio da similaridade no notebook, para o portão de relevância por z-score). Sumários ficam fora das listas densa/esparsa.
4. União dos IDs → textos e metadados **em lote no SQLite** (só documentos `processed`).
5. **Fusão RRF** (k=60) das listas densa e esparsa, com o voto lexical ponderado pela fração dos termos da pergunta presentes no trecho; casamento exato de código e período citado têm prioridade; portão de relevância.
6. **Reranking local** (filtro de precisão): os 25 melhores candidatos que passaram no portão são pontuados por um **Cross-Encoder** em CPU (ONNX, sem Ollama), que lê pergunta e trecho juntos; a quantidade que segue ao prompt **não é fixa**: vão todos os que passam no **corte de relevância** (nota até `RERANK_MAX_GAP`, 6, abaixo da do melhor), seja 1 ou 12, do mais relevante para o menos relevante, até caberem no contexto do modelo. O melhor trecho e os com o código exato citado sempre seguem, na frente. Calibrado na base de teste: comparado ao antigo teto de 5, recupera 84% dos trechos do gabarito (antes 75%) com 63% de precisão (antes 57%). `RERANK_TOP_N` impõe um teto, se quiser (4 nos modelos < 1B). Sem o modelo pronto (1º download) ou com `RERANK_ENABLED=false`, vale o corte relativo da pontuação combinada com o top-K do perfil.
7. Trechos vizinhos dos 2 melhores resultados, montagem do contexto com limite de tamanho, **ranqueado do mais relevante para o menos relevante** (registros exatos por código primeiro; o prompt avisa a ordem ao modelo). `CONTEXT_ORDER=relevance_last` inverte: o mais relevante fica por último, junto da pergunta (com qwen3.5:2b: 14/14 contra 12/14 nas perguntas de histórico/versão do benchmark). Passagens vão inteiras; só a que não cabe no espaço restante é reduzida às frases que mais combinam com a pergunta. LLM do Windows em streaming.

A fusão é feita na aplicação (e não com `fusion: rrf` do Qdrant) porque o ranqueamento usa as pontuações individuais de cada lista (portão por z-score, cobertura de termos), calibradas pelo benchmark.

### Collection do Qdrant

| Item | Configuração | Motivo |
|---|---|---|
| Vetor denso `dense` | dimensão do modelo (1024 no `bge-m3`), Cosine, `on_disk: true` | originais em disco (memmap); a RAM fica com os quantizados |
| Vetor esparso `bm25` | `modifier: idf` | o Qdrant calcula o IDF; a aplicação envia a frequência saturada BM25 (k1=1,4, b=0,75, comprimento médio `BM25_AVG_DOC_LEN`) |
| Índice BM25 | `index.on_disk: true` (`QDRANT_SPARSE_ON_DISK`) | índice invertido em memmap: a RAM não cresce com o vocabulário; o cache de páginas do sistema mantém quente o que é usado |
| Quantização | `scalar int8`, `quantile 0.99`, `always_ram: true` (padrão; `QDRANT_QUANTIZATION`) | 4× menos RAM por vetor (1 KB em vez de 4 KB no bge-m3); `binary2` (2 bits, 256 B) e `binary` (1 bit, 128 B) para bases muito grandes |
| Busca | `rescore: true`, `oversampling: 2` (mínimo 4 nas binárias), `hnsw_ef: 128` | pré-seleção quantizada, ordem final com float32: precisão preservada |
| HNSW | `m: 0`, `payload_m: 16` + `notebook_id` com `is_tenant` | multitenancy: um grafo por notebook, sem grafo global (toda busca é por notebook) |
| Índices de payload | `notebook_id`, `document_id`, `source_type`, `codes` (keyword), `chunk_index` (integer), `toc` (bool) | filtros, exclusão por documento, faceta da reconciliação |
| Payload | IDs, posição, códigos, página, modelo — **sem o texto** | o texto fica só no SQLite |

Quantização e índice BM25 valem também para a collection existente: na inicialização a aplicação compara a configuração e aplica a diferença com `PATCH` (o Qdrant reconstrói em segundo plano, sem reindexar e sem parar a busca).

Trocar o modelo de embeddings: as perguntas avisam para clicar em **Reindexar** (nunca misturam vetores de modelos diferentes); a primeira reindexação recria a collection com a nova dimensão.

### Chunking

- **Estrutural:** divide por seção (o caminho de títulos vai no início de cada trecho, `[Seção: …]`), tabelas são cortadas só entre linhas e repetem o cabeçalho, listas não são quebradas no meio de um item, prosa longa é dividida por parágrafo/frase com `CHUNK_OVERLAP`; fragmentos curtos (título solto) são anexados ao trecho anterior. CSV e planilhas viram tabelas Markdown.
- **PDF:** cabeçalhos e rodapés repetidos, números de página e linhas de sumário são removidos, títulos numerados ("5.2 Oven Monitoring") viram seções, e cada trecho guarda as **páginas de origem** (`page_start`/`page_end`, exibidas nas fontes como "p. N").
- O vetor de cada trecho leva o nome do documento; `CHUNK_SIZE`/`CHUNK_OVERLAP` são configuráveis.
- **Registros:** linhas de tabelas e fichas no formato `### CÓDIGO — Título` + `- **Campo:** valor` ficam na tabela `records`. Perguntas de filtro ("orçamento acima de R$ 500.000"), comparação entre colunas, contagem, soma, média, maior/menor, ordenação e listagem completa são respondidas por cálculo determinístico sobre todos os registros. `STRUCTURED_QUERIES=false` desliga.

### SQLite

Tabelas: `notebooks`, `documents` (status, `stage`, progresso, modelo de embeddings, texto colado, `content_hash`, `external`), `chunks` (texto, texto normalizado, seção, páginas, `toc`, `indexed` 0/2/1 = fora do Qdrant/só BM25/completo; `UNIQUE(document_id, chunk_index)`), `records`, `conversations`, `messages`, `saved_messages` (`indexed`), `vector_deletions`, `document_summaries` (resumo guardado por documento), `settings`, `ai_providers`. Sem embeddings e sem cálculo de similaridade. Bancos da versão anterior (vetores em BLOB) não são migrados: a aplicação recusa e pede um `SQLITE_PATH` novo.

## Configuração

Todas as variáveis estão em [.env.example](.env.example) (comentadas) e são repassadas pelo [docker-compose.yml](docker-compose.yml). Obrigatórias (validadas na inicialização): `MASTER_USER`, `MASTER_PASSWORD`, `QDRANT_API_KEY`. Servidor Ollama, modelos, contexto, tamanho da resposta, trechos por pergunta e threads **não** são variáveis de ambiente: ficam na tela Configurações (guardados no SQLite).

- **Conexões:** `QDRANT_URL` (fixo `http://qdrant:6333` no Compose), `QDRANT_API_KEY`, `QDRANT_COLLECTION`.
- **Qdrant:** `QDRANT_QUANTIZATION` (`int8`, `binary2`, `binary`), `QDRANT_QUANTIZED_IN_RAM`, `QDRANT_SPARSE_ON_DISK`, `QDRANT_QUANTILE`, `QDRANT_OVERSAMPLING`, `QDRANT_HNSW_EF`, `QDRANT_ON_DISK_VECTORS`.
- **Ingestão:** `CHUNK_SIZE`, `CHUNK_OVERLAP`, `EMBED_BATCH_SIZE`, `BM25_AVG_DOC_LEN`, `DOCUMENT_PROCESS_CONCURRENCY`, `MAX_FILE_SIZE_MB` (também o limite por arquivo da importação de pasta), `IMPORT_DIR`, `OCR_LANG`, `SYNC_INTERVAL_MIN`.
- **Busca e memória:** `MIN_RELEVANCE_SCORE`, `CONTEXT_ORDER`, `CONVERSATION_ROUTING`, `CONVERSATION_JUDGE_BELOW`, `NEIGHBOR_EXPAND_TOP`, `HISTORY_MESSAGES`, `HISTORY_MAX_CHARS`.
- **Reranking local:** `RERANK_ENABLED`, `RERANK_MODEL`, `RERANK_MODEL_FILE`, `RERANK_CANDIDATES`, `RERANK_TOP_N`, `RERANK_MAX_GAP`, `RERANK_MAX_LENGTH`, `RERANK_BATCH`, `RERANK_THREADS`, `RERANK_DIR`, `RERANK_HF_URL` (ver [Recuperação híbrida](#recuperação-híbrida)).
- **Infra:** `PORT`, `APP_BIND`, `VOLUMES_DIR`, `APP_UID`/`APP_GID`.

## Testes

Tudo em containers (o serviço `tests` usa a imagem com dependências de desenvolvimento):

```bash
docker compose --profile test run --rm --no-deps tests npm run test:unit   # determinísticos (chunking, registros, memória…)
docker compose --profile test run --rm tests npm run test:integration       # integração REAL: Qdrant do Compose + Ollama do Windows
docker compose --profile test run --rm tests npm run bench -- --label qdrant # benchmark ponta a ponta (47 perguntas com gabarito)
docker compose --profile test run --rm tests npm run bench -- --retrieval    # só a recuperação (P@K, R@K, MRR), sem gerar: ~1 s/pergunta
bash scripts/e2e.sh                                                          # API HTTP da aplicação no ar, inclusive reinício dos containers
```

Opções do benchmark ([scripts/bench.mts](scripts/bench.mts)): `--retrieval` mede só a recuperação; `--distract <pasta>` indexa outros documentos no mesmo notebook (até `--distract-mb` MB) para ver como a recuperação se comporta com a base maior; `--variants "A=1;A=2 B=3"` indexa uma vez e repete as perguntas com cada conjunto de variáveis (os vetores BM25 são regravados entre as variantes, sem recalcular embeddings); `--only id1,id2`; `--src` mede outra cópia do código.

Os testes de integração e o benchmark usam collections temporárias (`it_*`, `bench_*`) e SQLite temporário, sem tocar nos dados da aplicação. Cobrem: criação e configuração da collection (denso, esparso, INT8, índices), ingestão com IDs consistentes, payload sem texto, buscas densa/esparsa/por código/isolamento por notebook, pipeline completo com o LLM, reprocessamento idempotente, atualização, exclusão, Ollama indisponível, falha parcial, Qdrant indisponível (exclusão adiada), órfãos, mensagens salvas, troca de modelo, reconstrução total do índice (respondendo pelo BM25 antes dos embeddings), escopo por documento, ajuste de quantização sem recriar e importação de pasta com deduplicação.

## Uso

Crie um notebook, adicione arquivos compatíveis (PDF, DOCX, PPTX, XLSX/XLS, CSV, TXT, Markdown, JSON, código, HTML/XML e imagens PNG/JPG/WebP/BMP/TIFF) ou texto colado e aguarde o estado `processed`. É possível selecionar vários arquivos por envio (até 50), cada um de até 100 MB por padrão; arquivos com conteúdo já presente no notebook são ignorados. Para muitos arquivos, use **Pasta**: coloque-os em `IMPORT_DIR` (padrão `./import` na pasta do projeto, uma subpasta por assunto se quiser) e importe; a pasta é varrida com as subpastas, os arquivos são lidos onde estão e excluir o documento no Bento não apaga o original. O documento responde perguntas logo após a fase BM25 (segundos); a busca semântica completa em segundo plano.

**Focar:** no cartão do documento, **Focar** restringe as perguntas aos documentos focados (a faixa acima da caixa de pergunta mostra quais; "Todos os documentos" desfaz). Vale para a busca, os registros estruturados e o modo resumo; fica salvo por notebook no navegador. Documentos com erro podem ser reprocessados pela interface. Abra uma conversa e pergunte; a primeira troca gera automaticamente um título curto para a conversa. Mensagens salvas podem ser abertas para leitura e também são indexadas como contexto do notebook; remover uma mensagem da lista de salvas não apaga a mensagem original da conversa. A resposta inclui trechos-fontes recuperados. Conversas, documentos e vetores permanecem após reiniciar os containers. Excluir documento remove seus trechos (SQLite), pontos (Qdrant) e o arquivo enviado (o importado de pasta fica onde está); excluir notebook remove seus dados associados nos dois bancos.

## Modo de voz

No notebook, o botão **Voz** (ao lado de Enviar, ou `Ctrl+Shift+Espaço`) abre uma conversa falada em tela cheia: você fala, o Bento detecta a pausa, transcreve, pergunta ao notebook pelo mesmo caminho do chat (a troca fica salva na conversa) e responde em voz alta, frase a frase, enquanto o modelo ainda escreve. Espaço interrompe ou envia na hora, M pausa o microfone e Esc fecha. Em **Voz e efeitos** dá para trocar a voz, a velocidade, o efeito (Jarvis, sutil ou natural), a pausa que encerra a fala e ativar a interrupção por voz (recomendado com fone, para o microfone não captar a própria resposta).

Com o modo **Conversa** ligado (na voz ou no chat), o Bento decide quando consultar os documentos: "oi, tudo bem?", "bom dia", "obrigado", "quem é você?" e reações ("entendi", "que legal") são respondidos direto, sem busca e sem fontes; mensagens mistas ("oi! qual o orçamento do PRJ-ARARA?") vão aos documentos. Quando a busca não acha trecho forte (melhor nota do reranking abaixo de `CONVERSATION_JUDGE_BELOW`, 0), a própria IA decide em ~1 s se a mensagem pede algo dos documentos ("que horas são?", "me conta uma piada" e "estou cansado" ficam como conversa). Na dúvida, consulta os documentos. `CONVERSATION_ROUTING=false` desliga. No modo Consulta, o RAG é sempre usado.

Tudo roda localmente no servidor com [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), sem serviços externos:

- **Transcrição:** NVIDIA Parakeet TDT 0.6B v3 (int8; ~0,3 s por pergunta curta em CPU, detecta português/inglês e pontua; ~10% de palavras erradas em fala real do Multilingual LibriSpeech, contra 30% do Whisper base). `VOICE_STT_MODEL=whisper-turbo` erra ~16% menos, mas leva ~3 s por pergunta; `whisper-base` é a opção leve para servidores com pouca memória. Códigos do notebook ditos em voz alta ("app mês", "for 002") são reescritos no formato exato (`APP-MES`, `FOR-002`) para a busca por código do RAG funcionar.
- **Captura:** pré-gravação de 0,6 s (não corta o início da fala), volume normalizado antes da transcrição e filtro de ruído do navegador opcional. Em **Voz e efeitos**, "Revisar o texto antes de enviar" permite corrigir o que foi entendido, e o botão de alto-falante ao lado da pergunta toca exatamente o áudio enviado à transcrição (para saber se o problema é o microfone ou o modelo).
- **Voz:** Piper (VITS) pt-BR — Faber, Cadu ou Jeff — e britânica (Alan ou Northern) para respostas em inglês; ~0,1–0,3 s por frase. Números, moeda, datas e horas são normalizados antes da síntese.

Na primeira abertura os modelos são baixados do Hugging Face para `VOICE_DIR` (`APP_DATA_DIR/voice`, no volume `app/`; ~740 MB, com progresso na tela). Com Parakeet, o modo de voz ocupa ~1 GB de RAM depois de aberto pela primeira vez. **O navegador só libera o microfone em HTTPS ou em `http://localhost`**: para acessar pela rede, use um proxy com TLS. Variáveis: `VOICE_ENABLED`, `VOICE_DIR`, `VOICE_STT_MODEL`, `VOICE_STT_LANGUAGE` (só Whisper), `VOICE_NUM_THREADS`, `VOICE_HF_URL` (espelho do Hugging Face).

## API

- `GET/POST /api/notebooks`, `PATCH/DELETE /api/notebooks/:id`
- `GET /api/notebooks/:id/documents`, `POST /api/notebooks/:id/documents` (multipart `file`), `POST /api/notebooks/:id/text`
- `POST /api/documents/:id/reprocess`, `DELETE /api/documents/:id`
- `GET/POST /api/notebooks/:id/conversations`
- `GET /api/conversations/:id/messages`, `POST /api/conversations/:id/messages` (`content`)
- `GET/POST /api/ai/providers`, `PUT/DELETE /api/ai/providers/:id`, `POST /api/ai/providers/:id/test`, `POST /api/ai/models`
- `GET /api/ai/status`, `PUT /api/ai/active` (`{chat, embedding}` com ids de provedores)
- `GET /healthz` (sem login; `?live=1` só o processo), `GET /api/system/info` (inclui `vectorStore`), `GET/POST /api/system/sync` (último relatório / executa a reconciliação SQLite ↔ Qdrant)
- `GET /api/voice/status`, `POST /api/voice/prepare` (`{voice, voiceEn}`: baixa/carrega os modelos), `POST /api/voice/transcribe` (PCM 16 bits, 16 kHz, mono → `{text}`), `POST /api/voice/speak` (`{text, voice, voiceEn, speed}` → WAV)

## Notas

OCR local de imagens é feito com Tesseract.js, pré-processando rotação, escala, contraste e nitidez. Português e inglês são reconhecidos juntos por padrão (`OCR_LANG=por+eng`; também aceita `por` ou `eng`). A recuperação e as respostas aceitam português e inglês; o idioma da resposta acompanha o idioma da pergunta. PDFs escaneados não são convertidos automaticamente para imagens e, portanto, precisam de OCR externo ou ser enviados como imagens. Os limites podem ser ajustados por `MAX_FILE_SIZE_MB` e o máximo de arquivos por envio é 50. Cada documento é indexado individualmente e cada busca consulta somente o notebook ativo; a conversa não injeta o histórico inteiro ao modelo, limitando o contexto para proteger máquinas modestas.

## Configurações de IA

A tela **Configurações** (engrenagem no topo) é o único lugar onde a IA é configurada. **Configurar automaticamente** procura o Ollama (localhost, IP do Windows visto pelo WSL2), escolhe entre os modelos instalados (chat de família conhecida e embeddings como o `bge-m3`) e deixa em uso o que ainda estiver sem escolha, sem trocar o que você já usa. O sistema só usa Ollama, então não há escolha de tipo de provedor. O cadastro manual (**Adicionar**, **Editar**, **Excluir**) tem dois passos: (1) o servidor, que a tela já procura sozinha ao abrir (**Atualizar** procura de novo ou lê o endereço digitado, ex.: `http://172.29.48.1:11434`); (2) o modelo, escolhido entre os instalados no servidor (ou digitado). Nome (sem ele, usa o endereço) e chave de API (só se o servidor exigir) ficam em **Opções avançadas**.

Em **IA em uso** escolha qual cadastro responde o chat e qual gera os embeddings (podem ser o mesmo servidor ou servidores diferentes). **Testar** faz uma chamada real a cada modelo cadastrado. As chaves ficam no SQLite do servidor e nunca são devolvidas ao navegador (só os 4 últimos caracteres).

Antes de cada inferência a aplicação confere (com cache curto) se o servidor responde e se o modelo está instalado; se não, a mensagem diz qual modelo baixar no Windows.

**Trocar o modelo de embeddings exige "Reindexar"** (documentos e mensagens salvas), pois vetores de modelos diferentes não são comparáveis; as perguntas avisam enquanto isso não for feito.

## Ajuste automático ao modelo local

O RAG não é otimizado para um modelo só: ele reconhece o modelo de chat ativo (tamanho, família, contexto nativo e se só raciocina, consultando o Ollama e, na falta, o nome) e ajusta sozinho a amostragem, o limite de tokens, o `num_ctx`, o top-K, o tamanho do contexto e o uso de histórico. Exemplos: `qwen3:4b-instruct-2507-q4_K_M` → perfil médio, família Qwen3 (`top_k` 20, sem decodificação gulosa); `llama3.1:8b` → grande; `gemma3:270m` → mini. Troque o modelo em Configurações e use **Testar** para ver o perfil detectado. Em **Configurações > Contexto e desempenho** cada valor (contexto, tamanho da resposta, texto dos documentos, trechos por pergunta e threads) é **Automático** (o perfil do modelo, mostrado na tela) ou **Manual**, que vale para qualquer modelo; o contexto manual nunca passa do contexto nativo do modelo.

## Ajuste automático ao computador

Antes de aceitar conexões, o servidor analisa o PC e se ajusta a ele ([src/tuning.ts](src/tuning.ts)); funciona em qualquer notebook ou desktop, sem configuração:

1. Detecta CPU (núcleos físicos e lógicos), RAM e GPU.
2. Mede, com o modelo de chat ativo, a velocidade do Ollama com algumas quantidades de threads (metade, 75%, núcleos − 1 e todos os núcleos físicos, refinando em volta da melhor) e escolhe a de menor tempo estimado de resposta (leitura do prompt + geração). Empates ficam com menos threads, deixando CPU para o app. Se o modelo roda inteiro na GPU, as threads não importam e a medição é pulada.
3. Guarda o resultado em `APP_DATA_DIR/tuning.json` (volume `app/`), por CPU, RAM, servidor, versão do Ollama e modelo: só a 1ª inicialização de cada PC/modelo mede (20 s a 2 min); as seguintes usam o valor salvo. Apagar o arquivo e reiniciar mede de novo; trocar o modelo em Configurações mede/aplica em segundo plano.
4. Pré-carrega embeddings e chat com as mesmas opções das perguntas (`num_ctx` e `num_thread` iguais, então o Ollama não recarrega): a 1ª pergunta já não paga a carga do modelo.
5. Avisa no log quando a GPU está ociosa (Ollama só na CPU) ou quando chat e embeddings se expulsam da memória a cada pergunta.

Em Configurações, as threads podem ficar em **Automático** (medido), **Manual** ou **Deixar o Ollama decidir** (sem medição). O `num_ctx` não é ajustado pela medição: nos testes ele não mudou a velocidade (só reserva memória, ~270 MB de 3072 para 8192 no qwen2.5:3b), então no automático vem do perfil do modelo (ou do valor manual de Configurações), dimensionado para nunca truncar prompt + histórico + resposta (3072 até 2,5B; 6144 no 3–4B).

Medições no Ryzen 7 7735U (8 núcleos, 32 GB), prompt típico do RAG (~1200–1500 tokens):

| Configuração | qwen2.5:1.5b: 1º token · geração | qwen2.5:3b: 1º token · geração |
|---|---|---|
| CPU, 4 threads | 7,3 s · 23,6 tok/s | 21,9 s · 12,4 tok/s |
| CPU, 7 threads (escolhido na CPU) | 4,9 s · 26,5 tok/s | ~14 s · 13,2 tok/s |
| GPU integrada Radeon 680M (Vulkan) | **2,2 s · 39,8 tok/s** | **4,7 s · 22,6 tok/s** |

`num_batch` (256–1024) não fez diferença e fica no padrão.

## Capacidade e escala

Não há limite de tamanho por notebook nem no total; os limites são o upload (`MAX_FILE_SIZE_MB` por arquivo, 50 por envio; a importação de pasta não tem limite de quantidade) e o hardware. O modelo de chat nunca lê o notebook inteiro: cada pergunta leva só os trechos mais relevantes (~8.000 caracteres no Qwen3.5-2B), então o tamanho da base não muda o custo da geração.

Custo por trecho (~600 caracteres úteis; 1 página ≈ 5 trechos; 1 MB de texto ≈ 1.700 trechos), com bge-m3:

| Recurso | Por trecho | 100 mil trechos (~20 mil páginas) | 1 milhão de trechos |
|---|---|---|---|
| RAM do Qdrant, vetor quantizado `int8` (padrão) | ~1 KB | ~100 MB | ~1 GB |
| idem com `QDRANT_QUANTIZATION=binary2` / `binary` | ~256 B / ~128 B | ~25 / ~13 MB | ~250 / ~130 MB |
| Índice BM25 | em disco (memmap) | — | — |
| Disco (vetor float32 + esparso + SQLite) | ~7–8 KB | ~0,8 GB | ~8 GB |

O gargalo de verdade é o embedding no Ollama (~6 trechos/s com bge-m3 na CPU deste PC: 100 mil trechos ≈ 5 h). Com a indexação em duas fases, isso não bloqueia o uso: tudo fica pesquisável por BM25 em segundos e a busca semântica completa em segundo plano.

Medições do benchmark `--retrieval` (a coluna "Antes" das perguntas vagas é a variante com o BM25 antigo, que se comporta igual ao código anterior nas outras 39) com a base de teste + 1 MB de artigos da Wikipédia em português sobre temas parecidos (34 documentos, 1.992 trechos), 47 perguntas:

| | Antes | Agora |
|---|---|---|
| Tempo até ficar pesquisável | 322 s | 3 s (BM25; semântica completa em 320 s, em segundo plano) |
| P@K / R@K / MRR (39 perguntas originais) | 67,6% / 95,9% / 0,864 | 67,8% / 95,9% / 0,868 |
| Perguntas vagas novas (sinônimos que não estão no texto) | 8/8 | 8/8 com a evidência recuperada |
| Termos no índice BM25 por trecho | 55,1 | 49,7 (−10%) |

Testado e **descartado** por não melhorar nada no benchmark: palavra inteira ao lado do radical no BM25 (+55% de índice), bigramas (+92% de índice) e expansão da pergunta pelo LLM quando a busca não acha nada. A busca estrita nunca voltou vazia, e as perguntas vagas já são resolvidas pela busca densa.

Para dimensionar: até alguns GB de texto (milhões de trechos) cabem com `int8` num PC de 16–32 GB; acima disso, `binary2` corta a RAM dos vetores em 4x. No benchmark com 2 mil trechos, `int8`, `binary2` e `binary` deram exatamente a mesma recuperação (P@K 57,0%, R@K 96,7%, MRR 0,803 nas 47 perguntas), graças ao rescore com os originais. Com milhões de trechos e o grafo HNSW a diferença pode aparecer, por isso o padrão continua `int8`: antes de trocar uma base grande, meça com `--variants "QDRANT_QUANTIZATION=int8;QDRANT_QUANTIZATION=binary2"`. Notebooks temáticos dão respostas melhores que um notebook único com tudo; **Focar** restringe a pergunta a alguns documentos.

## Otimizações gerais

- **Streaming**: a resposta aparece token a token (`POST /api/conversations/:id/messages?stream=1`, NDJSON); sem `stream=1` o comportamento antigo é mantido.
- **Menos chamadas ao LLM**: cada pergunta faz 1 embedding + 1 geração.
- **Memória de conversa** (pensada para modelos de 1–4B): perguntas de acompanhamento viram autônomas antes da busca em todos os tamanhos de modelo, inclusive 1B/1.5B. Com pronome ou "e …", o código do item de que se falava é herdado da pergunta ou da resposta anterior sem chamar o LLM ("e o patrocinador dele?" → "e o patrocinador dele (PRJ-ARARA)?"); pedidos como "explique melhor" reaproveitam o assunto anterior; só os casos sem pista são reescritos pelo LLM (do 3B em diante, com validação dos códigos). Os turnos anteriores entram no prompt só do 3B em diante e só em perguntas de acompanhamento (mudança de assunto não paga tokens de histórico); recusas anteriores ficam de fora. `HISTORY_MESSAGES` e `HISTORY_MAX_CHARS` limitam essa janela.
- **Modo resumo**: perguntas como "resuma", "visão geral" ou "principais pontos" não buscam por similaridade. Se ao menos metade dos documentos já tem **resumo guardado** (gerado pelo **One page**, tabela `document_summaries`), cada documento entra com o seu resumo, que cobre o documento inteiro; os demais entram com o trecho inicial. Sem resumos, vale a amostra de trechos espalhados de antes. Os resumos valem enquanto o conteúdo do documento não muda.
- **One page**: documento estruturado (HTML A4; Ctrl+P salva em PDF) com o resumo geral de tudo o que está no notebook: sumário, visão geral, temas principais, uma seção por documento (assunto, pontos principais, detalhes importantes), dados-chave e termos. Nada é amostrado: a IA lê cada documento inteiro por **janela deslizante** (janelas do tamanho do contexto do modelo, com sobreposição, levando as notas das partes anteriores) e consolida as notas em camadas quando não cabem no contexto. É um trabalho longo (uma chamada ao modelo por janela, de minutos a horas): roda no servidor, mostra a fase, as etapas e o tempo restante, pausa enquanto o chat responde e pode ser cancelado; o que já foi lido fica guardado (`onepage_digests`), então gerar de novo continua de onde parou e só paga os documentos novos ou alterados.
- **Menções no chat**: digite `@` para escolher um documento (autocompletar) e focar a pergunta nele; vale também digitar o nome inteiro (`@Manual.pdf qual o prazo?`). O nome sai do texto usado na busca e só a menção, sem pergunta, pede o resumo do documento.
- **Precisão**: corte relativo de trechos fracos (< 80% do melhor), prompt mais curto e restritivo, `temperature=0.1` e `repeat_penalty`.
- **Velocidade**: texto normalizado pré-calculado por trecho (`chunks.search_text`), uma única requisição em lote ao Qdrant por busca, textos buscados em lote no SQLite, conexões HTTP reaproveitadas e `keep_alive=30m` no Ollama, evitando recarregar modelos entre embedding e chat.

## Recuperação híbrida

- **Busca híbrida no Qdrant**: BM25 (vetores esparsos com stemming leve para português, palavras funcionais fora do índice, IDF do Qdrant) + similaridade vetorial densa, combinadas por fusão de ranks (RRF). Nomes, siglas e códigos vêm do BM25; paráfrases vêm dos embeddings. Detalhes em [Arquitetura de recuperação](#arquitetura-de-recuperação).
- **Sem índice em memória**: a memória da aplicação não cresce com o volume de documentos; os vetores ficam no Qdrant (INT8 na RAM, originais em disco).
- **Portão de relevância**: trecho sem nenhum termo em comum com a pergunta só entra se se destacar estatisticamente dos demais (z-score). Perguntas fora do assunto dos documentos são recusadas sem gastar uma chamada ao modelo de chat.
- **Reranking local** ([src/rerank.ts](src/rerank.ts)): Cross-Encoder `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` (multilíngue, treinado no mMARCO, que inclui português; int8, ~135 MB) via transformers.js + onnxruntime-node. Medido no container (CPU de 8 núcleos): ~0,8–1 s para 25 trechos em lotes de 4 (`RERANK_BATCH`); ocupa ~380 MB de RAM (tokenizer multilíngue ~115 MB, modelo ~170 MB, inferência ~90 MB). O `onnx-community/bge-reranker-v2-m3-ONNX` (int8, ~570 MB) teve a mesma precisão na base de teste, mas ~11 s por pergunta; use-o só com CPU folgada. O modelo é baixado do Hugging Face na inicialização para `APP_DATA_DIR/reranker`; até terminar, as perguntas seguem sem reranking. Variáveis: `RERANK_ENABLED`, `RERANK_MODEL`, `RERANK_MODEL_FILE`, `RERANK_CANDIDATES` (25), `RERANK_MAX_GAP` (6: segue todo trecho com nota até 6 abaixo da do melhor, sem número fixo; não há piso absoluto porque o Cross-Encoder dá notas baixas a linhas de tabela), `RERANK_TOP_N` (teto opcional; vazio = sem teto, 4 nos modelos < 1B), `RERANK_MAX_LENGTH`, `RERANK_BATCH`, `RERANK_THREADS`, `RERANK_DIR`, `RERANK_HF_URL`. O log mostra `trechos 7 relevantes de 25 (rerank …ms, melhor 9.5) · contexto 6120/8000 chars · prompt ~2900+350 de 8192 tokens (Ollama processou …)`.
- **Orçamento de contexto** ([src/rag.ts](src/rag.ts), `ask`): instruções, histórico, pergunta e o teto da resposta são contados primeiro; os trechos ocupam só o que sobra do `num_ctx` (8192 tokens no Qwen3.5-2B), limitado ao tamanho que o modelo aproveita bem ("Texto dos documentos" em Configurações; 8000 caracteres no perfil pequeno). Tokens estimados com 2,5 caracteres por token (medido no qwen3.5:2b: 3,8–4,2 em texto corrido, ~3 em prompts cheios de tabelas), então o prompt nunca passa do contexto, o que faria o Ollama cortar as instruções sem avisar. Se os trechos relevantes não cabem, saem primeiro os vizinhos; depois os menos relevantes, pelo ranking.
- **Trechos vizinhos** (`NEIGHBOR_EXPAND_TOP`): os melhores resultados ganham os trechos adjacentes, e trechos contíguos viram uma passagem única, sem repetir o overlap.
- **Prefixos de embedding**: `nomic-embed-text` (`search_query:`/`search_document:`) e modelos `e5` (`query:`/`passage:`) usam os prefixos para os quais foram treinados. **Reprocesse os documentos** ao adotar esta versão com esses modelos.
- **Log de tempos** no servidor: `[RAG] busca … · 1º token … · geração …`.

### Dica de desempenho do Ollama

Configurações do próprio Ollama (variáveis de ambiente do servidor Ollama; no Windows, defina-as no usuário e reinicie o Ollama) que o app não consegue mudar sozinho, mas avisa no log quando faltam:

- `OLLAMA_MAX_LOADED_MODELS=2` (ou mais): com 1, o Ollama troca entre embeddings e chat a cada pergunta (medido: +3,6 s por pergunta com o qwen2.5:1.5b; 2 a 7 s conforme o modelo).
- GPU integrada AMD/Intel: `OLLAMA_VULKAN=1` liga a aceleração Vulkan (Radeon 680M: 1º token 2–3× mais rápido, geração 1,5–1,7× mais rápida). Não defina `OLLAMA_LLAMACPP_DISABLE_GPU=1`. NVIDIA usa CUDA com o driver atualizado; Mac Apple Silicon usa Metal automaticamente.
