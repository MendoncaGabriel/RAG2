# Bento

Bento é uma aplicação local de RAG com notebooks independentes, Express/TypeScript, SQLite e IA exclusivamente com Ollama (chat e embeddings locais). Usa o módulo SQLite integrado ao Node.js (`node:sqlite`, Node 22.13+), evitando dependências nativas para o banco. A recuperação é semântica: embeddings persistidos como vetores Float32 no SQLite e similaridade de cosseno calculada localmente em JavaScript, filtrando estritamente pelo notebook selecionado. Isso evita dependências nativas adicionais (`sqlite-vec`). A busca é exata e linear, adequada a bases locais pequenas e médias.

## Requisitos

- Node.js 22.13 ou superior e npm.
- Ollama em execução (`ollama serve`), na mesma máquina ou em outro servidor.
- Espaço em disco para o SQLite e arquivos enviados.

## Instalação e execução

```bash
npm install
```

Copie `.env.example` para `.env` (no Windows: `copy .env.example .env`) e ajuste se necessário. Inicie com:

```bash
npm run dev
```

Acesse http://localhost:3000 e abra **Configurações** (engrenagem no topo) para cadastrar a IA — veja a seção abaixo. Para verificar a compilação TypeScript: `npm run typecheck`. Para gerar a versão de produção e executá-la localmente: `npm run build` e `npm start`. Ao iniciar (`npm start` ou `npm run dev`), o app primeiro analisa o PC e ajusta o Ollama a ele — veja [Ajuste automático ao computador](#ajuste-automático-ao-computador).

### Docker Compose

Um único comando sobe tudo: o app, um Ollama e o download dos modelos (`qwen2.5:3b` para chat e `bge-m3` para embeddings, ~2 GB na primeira vez; acompanhe com `docker compose logs -f ollama-init`). O app inicia só depois do download e já vem com o provedor "Ollama (local)" cadastrado e ativo. Os modelos podem ser trocados com `OLLAMA_CHAT_MODEL` e `OLLAMA_EMBEDDING_MODEL` no `.env`.

```bash
docker compose up -d --build   # http://localhost:3000 (porta configurável com PORT)
```

O `docker-compose.linux.yml` (`network_mode: host`) não alcança o Ollama do Compose por nome; use-o apenas com IA externa:

```bash
docker compose -f docker-compose.yml -f docker-compose.linux.yml up -d --build
```

Para usar um proxy (nginx, Caddy, Traefik…), conecte-o à rede `app_net` apontando para `rag:3000`. Para usar um Ollama do host, cadastre-o com a URL `http://host.docker.internal:11434`. Todos os dados (SQLite, uploads, OCR) ficam em `./data`; o container roda como root por padrão para poder gravar nessa pasta (use `APP_UID`/`APP_GID` para outro usuário). Logs: `docker compose logs -f rag`.

No modo `docker-compose.linux.yml` o container usa a rede do host (`network_mode: host`), então `app_net` e o nome `rag` não se aplicam: o app fica em `localhost:3000` do servidor. Nesse modo cadastre o Ollama como `http://127.0.0.1:11434`. Alternativa sem esse arquivo: iniciar o Ollama com `OLLAMA_HOST=0.0.0.0`. O arquivo exige Docker Compose 2.24+.

## Configuração

`DATABASE_PATH`, `UPLOAD_DIR`, `CHUNK_SIZE`, `CHUNK_OVERLAP`, `RETRIEVAL_TOP_K`, `MIN_RELEVANCE_SCORE`, `MAX_CONTEXT_CHARS`, `CHAT_MAX_TOKENS` e `DOCUMENT_PROCESS_CONCURRENCY` são lidos do ambiente. Modelos e provedores não vêm do ambiente: são cadastrados na tela de Configurações. Para recuperação multilíngue português/inglês, `bge-m3` (Ollama) é uma boa escolha. Para servidor limitado, comece com `CHUNK_SIZE=700`, `CHUNK_OVERLAP=100`, `RETRIEVAL_TOP_K=4`, `MIN_RELEVANCE_SCORE=0.18`, `MAX_CONTEXT_CHARS=7000`, `CHAT_MAX_TOKENS=384` e `DOCUMENT_PROCESS_CONCURRENCY=1`. O processamento sequencial evita cargas simultâneas de OCR/embeddings e picos de memória; pode ser elevado a `2` para mais vazão se houver memória disponível. Menos contexto/resposta reduz RAM e latência; se respostas não recuperarem evidências suficientes, reduza `MIN_RELEVANCE_SCORE` ou aumente `MAX_CONTEXT_CHARS`/`RETRIEVAL_TOP_K`. A recuperação combina similaridade semântica com correspondência de termos exatos e percorre os vetores incrementalmente para manter o uso de memória limitado. Use sempre o mesmo modelo de embeddings para indexar e consultar; trocar modelo exige reprocessar todos os documentos já indexados. Diretórios e banco são criados localmente. Para trocar as configurações, pare o servidor antes de copiar/editar `.env`.

### Recuperação estruturada e testes

- **Chunking estrutural:** os documentos são divididos por seção (o caminho de títulos vai no início de cada trecho), tabelas são cortadas só entre linhas e repetem o cabeçalho, e listas não são quebradas no meio de um item. CSV e planilhas viram tabelas Markdown. Em PDFs, cabeçalhos e rodapés repetidos em todas as páginas, números de página e linhas de sumário são removidos, e títulos numerados ("5.2 Oven Monitoring") viram seções. O vetor de cada trecho leva o nome do documento; na busca, trechos de sumário são ignorados e a correspondência de termos pesa pela fração dos termos da pergunta presentes no trecho (ajuda com documentos em inglês e perguntas em português).
- **Registros:** linhas de tabelas e fichas no formato `### CÓDIGO — Título` + `- **Campo:** valor` ficam na tabela `records`. Perguntas de filtro ("orçamento acima de R$ 500.000"), comparação entre colunas ("abaixo do estoque mínimo"), contagem, soma, média, maior/menor, ordenação e listagem completa são respondidas por cálculo determinístico sobre todos os registros, com o cálculo mostrado na resposta. `STRUCTURED_QUERIES=false` desliga.
- **Busca:** códigos exatos citados na pergunta (`PRJ-ARARA`, `APP-MES`) têm prioridade sobre trechos apenas semelhantes, e o período citado (mês/ano) favorece o trecho histórico correspondente. As fontes exibidas são só as que sustentam a resposta.
- **Documentos antigos:** continuam funcionando. Na inicialização, os registros estruturados são extraídos do arquivo original sem recalcular embeddings; para o chunking novo, use "Reprocessar".
- `npm test` roda os testes determinísticos; `npm run bench -- --label nova --out bench.json` roda o benchmark ponta a ponta com o Ollama sobre `tests/fixtures/Base_RAG_Verdanis.md`.

## Uso

Crie um notebook, adicione arquivos compatíveis (PDF, DOCX, PPTX, XLSX/XLS, CSV, TXT, Markdown, JSON, código, HTML/XML e imagens PNG/JPG/WebP/BMP/TIFF) ou texto colado e aguarde o estado `processed`. É possível selecionar vários arquivos por envio (até 50), cada um de até 100 MB por padrão. Documentos com erro podem ser reprocessados pela interface. Abra uma conversa e pergunte; a primeira troca gera automaticamente um título curto para a conversa. Mensagens salvas podem ser abertas para leitura e também são indexadas como contexto do notebook; remover uma mensagem da lista de salvas não apaga a mensagem original da conversa. A resposta inclui trechos-fontes recuperados. Conversas, documentos e vetores permanecem após reiniciar o servidor. Excluir documento remove seus chunks/vetores e tenta remover o arquivo original; excluir notebook remove seus dados associados.

## Modo de voz

No notebook, o botão **Voz** (ao lado de Enviar, ou `Ctrl+Shift+Espaço`) abre uma conversa falada em tela cheia: você fala, o Bento detecta a pausa, transcreve, pergunta ao notebook pelo mesmo caminho do chat (a troca fica salva na conversa) e responde em voz alta, frase a frase, enquanto o modelo ainda escreve. Espaço interrompe ou envia na hora, M pausa o microfone e Esc fecha. Em **Voz e efeitos** dá para trocar a voz, a velocidade, o efeito (Jarvis, sutil ou natural), a pausa que encerra a fala e ativar a interrupção por voz (recomendado com fone, para o microfone não captar a própria resposta).

Tudo roda localmente no servidor com [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), sem serviços externos:

- **Transcrição:** NVIDIA Parakeet TDT 0.6B v3 (int8; ~0,3 s por pergunta curta em CPU, detecta português/inglês e pontua; ~10% de palavras erradas em fala real do Multilingual LibriSpeech, contra 30% do Whisper base). `VOICE_STT_MODEL=whisper-turbo` erra ~16% menos, mas leva ~3 s por pergunta; `whisper-base` é a opção leve para servidores com pouca memória. Códigos do notebook ditos em voz alta ("app mês", "for 002") são reescritos no formato exato (`APP-MES`, `FOR-002`) para a busca por código do RAG funcionar.
- **Captura:** pré-gravação de 0,6 s (não corta o início da fala), volume normalizado antes da transcrição e filtro de ruído do navegador opcional. Em **Voz e efeitos**, "Revisar o texto antes de enviar" permite corrigir o que foi entendido, e o botão de alto-falante ao lado da pergunta toca exatamente o áudio enviado à transcrição (para saber se o problema é o microfone ou o modelo).
- **Voz:** Piper (VITS) pt-BR — Faber, Cadu ou Jeff — e britânica (Alan ou Northern) para respostas em inglês; ~0,1–0,3 s por frase. Números, moeda, datas e horas são normalizados antes da síntese.

Na primeira abertura os modelos são baixados do Hugging Face para `VOICE_DIR` (`./data/voice`; ~740 MB, com progresso na tela). Para baixar antes: `npm run voice:download` (ou `npm run voice:download -- cadu alan`). Com Parakeet, o modo de voz ocupa ~1 GB de RAM depois de aberto pela primeira vez. **O navegador só libera o microfone em HTTPS ou em `http://localhost`**: para acessar pela rede, use um proxy com TLS. Variáveis: `VOICE_ENABLED`, `VOICE_DIR`, `VOICE_STT_MODEL`, `VOICE_STT_LANGUAGE` (só Whisper), `VOICE_NUM_THREADS`, `VOICE_HF_URL` (espelho do Hugging Face).

## API

- `GET/POST /api/notebooks`, `PATCH/DELETE /api/notebooks/:id`
- `GET /api/notebooks/:id/documents`, `POST /api/notebooks/:id/documents` (multipart `file`), `POST /api/notebooks/:id/text`
- `POST /api/documents/:id/reprocess`, `DELETE /api/documents/:id`
- `GET/POST /api/notebooks/:id/conversations`
- `GET /api/conversations/:id/messages`, `POST /api/conversations/:id/messages` (`content`)
- `GET/POST /api/ai/providers`, `PUT/DELETE /api/ai/providers/:id`, `POST /api/ai/providers/:id/test`, `POST /api/ai/models`
- `GET /api/ai/status`, `PUT /api/ai/active` (`{chat, embedding}` com ids de provedores)
- `GET /api/voice/status`, `POST /api/voice/prepare` (`{voice, voiceEn}`: baixa/carrega os modelos), `POST /api/voice/transcribe` (PCM 16 bits, 16 kHz, mono → `{text}`), `POST /api/voice/speak` (`{text, voice, voiceEn, speed}` → WAV)

## Notas

OCR local de imagens é feito com Tesseract.js, pré-processando rotação, escala, contraste e nitidez. Português e inglês são reconhecidos juntos por padrão (`OCR_LANG=por+eng`; também aceita `por` ou `eng`). A recuperação e as respostas aceitam português e inglês; o idioma da resposta acompanha o idioma da pergunta. PDFs escaneados não são convertidos automaticamente para imagens e, portanto, precisam de OCR externo ou ser enviados como imagens. Os limites podem ser ajustados por `MAX_FILE_SIZE_MB` e o máximo de arquivos por envio é 50. Cada documento é indexado individualmente e cada busca consulta somente o notebook ativo; a conversa não injeta o histórico inteiro ao modelo, limitando o contexto para proteger máquinas modestas. Docker não é obrigatório: Node.js 22.13+ pode rodar diretamente no servidor.

## Configurações de IA

A tela **Configurações** (engrenagem no topo) cadastra, edita, lista e remove servidores Ollama. Cada cadastro tem nome, URL base (padrão `http://localhost:11434`), chave de API opcional e modelos de chat e/ou embeddings.

Em **IA em uso** escolha qual cadastro responde o chat e qual gera os embeddings (podem ser o mesmo servidor ou servidores diferentes). O botão **Buscar modelos** lista os modelos do provedor e **Testar** faz uma chamada real. As chaves ficam no SQLite do servidor e nunca são devolvidas ao navegador (só os 4 últimos caracteres).

**Trocar o modelo de embeddings exige reprocessar os documentos e reindexar as mensagens salvas**, pois vetores de modelos diferentes não são comparáveis.

## Ajuste automático ao modelo local

O RAG não é otimizado para um modelo só: ele reconhece o modelo de chat ativo (tamanho, família, contexto nativo e se só raciocina, consultando o Ollama e, na falta, o nome) e ajusta sozinho a amostragem, o limite de tokens, o `num_ctx`, o top-K, o tamanho do contexto e o uso de histórico. Exemplos: `qwen3:4b-instruct-2507-q4_K_M` → perfil médio, família Qwen3 (`top_k` 20, sem decodificação gulosa); `llama3.1:8b` → grande; `gemma3:270m` → mini. Troque o modelo em Configurações e use **Testar** para ver o perfil detectado. Variáveis como `RETRIEVAL_TOP_K` ou `MAX_CONTEXT_CHARS` sobrescrevem o perfil quando definidas.

## Ajuste automático ao computador

Antes de aceitar conexões, o servidor analisa o PC e se ajusta a ele ([src/tuning.ts](src/tuning.ts)); funciona em qualquer notebook ou desktop, sem configuração:

1. Detecta CPU (núcleos físicos e lógicos), RAM e GPU.
2. Mede, com o modelo de chat ativo, a velocidade do Ollama com algumas quantidades de threads (metade, 75%, núcleos − 1 e todos os núcleos físicos, refinando em volta da melhor) e escolhe a de menor tempo estimado de resposta (leitura do prompt + geração). Empates ficam com menos threads, deixando CPU para o app. Se o modelo roda inteiro na GPU, as threads não importam e a medição é pulada.
3. Guarda o resultado em `data/tuning.json` (por CPU, RAM, servidor, versão do Ollama e modelo): só a 1ª inicialização de cada PC/modelo mede (20 s a 2 min); as seguintes usam o valor salvo. `npm run tune` mede de novo; trocar o modelo em Configurações mede/aplica em segundo plano.
4. Pré-carrega embeddings e chat com as mesmas opções das perguntas (`num_ctx` e `num_thread` iguais, então o Ollama não recarrega): a 1ª pergunta já não paga a carga do modelo.
5. Avisa no log quando a GPU está ociosa (Ollama só na CPU) ou quando chat e embeddings se expulsam da memória a cada pergunta.

`OLLAMA_NUM_THREAD` fixa as threads manualmente; `AUTOTUNE=false` desliga a medição. O `num_ctx` não é ajustado pela medição: nos testes ele não mudou a velocidade (só reserva memória, ~270 MB de 3072 para 8192 no qwen2.5:3b), então continua vindo do perfil do modelo, dimensionado para nunca truncar prompt + histórico + resposta (3072 até 2,5B; 6144 no 3–4B).

Medições no Ryzen 7 7735U (8 núcleos, 32 GB), prompt típico do RAG (~1200–1500 tokens):

| Configuração | qwen2.5:1.5b: 1º token · geração | qwen2.5:3b: 1º token · geração |
|---|---|---|
| CPU, 4 threads | 7,3 s · 23,6 tok/s | 21,9 s · 12,4 tok/s |
| CPU, 7 threads (escolhido na CPU) | 4,9 s · 26,5 tok/s | ~14 s · 13,2 tok/s |
| GPU integrada Radeon 680M (Vulkan) | **2,2 s · 39,8 tok/s** | **4,7 s · 22,6 tok/s** |

`num_batch` (256–1024) não fez diferença e fica no padrão.

## Otimizações gerais

- **Streaming**: a resposta aparece token a token (`POST /api/conversations/:id/messages?stream=1`, NDJSON); sem `stream=1` o comportamento antigo é mantido.
- **Menos chamadas ao LLM**: cada pergunta faz 1 embedding + 1 geração.
- **Memória de conversa** (pensada para modelos de 1–4B): perguntas de acompanhamento viram autônomas antes da busca em todos os tamanhos de modelo, inclusive 1B/1.5B. Com pronome ou "e …", o código do item de que se falava é herdado da pergunta ou da resposta anterior sem chamar o LLM ("e o patrocinador dele?" → "e o patrocinador dele (PRJ-ARARA)?"); pedidos como "explique melhor" reaproveitam o assunto anterior; só os casos sem pista são reescritos pelo LLM (do 3B em diante, com validação dos códigos). Os turnos anteriores entram no prompt só do 3B em diante e só em perguntas de acompanhamento (mudança de assunto não paga tokens de histórico); recusas anteriores ficam de fora. `HISTORY_MESSAGES` e `HISTORY_MAX_CHARS` limitam essa janela.
- **Modo resumo**: perguntas como "resuma", "visão geral" ou "principais pontos" amostram trechos de todos os documentos em vez de buscar por similaridade.
- **Precisão**: corte relativo de trechos fracos (< 80% do melhor), prompt mais curto e restritivo, `temperature=0.1` e `repeat_penalty`.
- **Velocidade**: texto normalizado pré-calculado por trecho (`chunks.search_text`, preenchido automaticamente em bases existentes) e `keep_alive=30m` no Ollama, evitando recarregar modelos entre embedding e chat.

## Recuperação híbrida

- **Busca híbrida**: BM25 (com stemming leve para português) + similaridade vetorial, combinadas por fusão de ranks (RRF). Nomes, siglas e códigos vêm do BM25; paráfrases vêm dos embeddings.
- **Índice em memória** por notebook, invalidado automaticamente quando documentos mudam: as perguntas deixam de reler e reprocessar o SQLite.
- **Portão de relevância**: trecho sem nenhum termo em comum com a pergunta só entra se se destacar estatisticamente dos demais (z-score). Perguntas fora do assunto dos documentos são recusadas sem gastar uma chamada ao modelo de chat.
- **Trechos vizinhos** (`NEIGHBOR_EXPAND_TOP`): os melhores resultados ganham os trechos adjacentes, e trechos contíguos viram uma passagem única, sem repetir o overlap.
- **Prefixos de embedding**: `nomic-embed-text` (`search_query:`/`search_document:`) e modelos `e5` (`query:`/`passage:`) usam os prefixos para os quais foram treinados. **Reprocesse os documentos** ao adotar esta versão com esses modelos.
- **Log de tempos** no servidor: `[RAG] busca … · 1º token … · geração …`.

### Dica de desempenho do Ollama

Configurações do próprio Ollama (variáveis de ambiente do servidor Ollama; no Windows, defina-as no usuário e reinicie o Ollama) que o app não consegue mudar sozinho, mas avisa no log quando faltam:

- `OLLAMA_MAX_LOADED_MODELS=2` (ou mais): com 1, o Ollama troca entre embeddings e chat a cada pergunta (medido: +3,6 s por pergunta com o qwen2.5:1.5b; 2 a 7 s conforme o modelo).
- GPU integrada AMD/Intel: `OLLAMA_VULKAN=1` liga a aceleração Vulkan (Radeon 680M: 1º token 2–3× mais rápido, geração 1,5–1,7× mais rápida). Não defina `OLLAMA_LLAMACPP_DISABLE_GPU=1`. NVIDIA usa CUDA com o driver atualizado; Mac Apple Silicon usa Metal automaticamente.
