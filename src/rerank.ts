// Reranking local (filtro de precisão): um Cross-Encoder lê pergunta e trecho juntos e dá a relevância real do par, o que a busca
// híbrida (vetores e BM25 calculados em separado) não consegue. Roda em CPU com ONNX (transformers.js + onnxruntime-node), sem Ollama.
// Padrão: mMiniLMv2-L12 treinado no mMARCO (multilíngue, inclui português), int8: ~1 s para 25 trechos em 8 núcleos (+~380 MB de RAM). O
// bge-reranker-v2-m3 (RERANK_MODEL=onnx-community/bge-reranker-v2-m3-ONNX) tem a mesma precisão na base de teste, mas ~11 s.
// O modelo é baixado do Hugging Face no 1º uso para RERANK_DIR. Enquanto não carrega (ou se falhar), a busca segue sem reranking.
import path from "node:path";
import { dataDir } from "./database.js";

const DEFAULT_MODEL = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1";
const envNum = (name: string, fallback: number) => { const v = Number(process.env[name]); return process.env[name]?.trim() && Number.isFinite(v) ? v : fallback; };
export const rerankEnabled = () => process.env.RERANK_ENABLED !== "false";
// Candidatos da busca híbrida que o Cross-Encoder reordena e quantos seguem para o prompt.
export const rerankCandidates = () => Math.max(1, Math.min(100, Math.round(envNum("RERANK_CANDIDATES", 25))));
// Teto opcional de trechos depois do reranking. Sem RERANK_TOP_N, quem chama decide (rag.ts: 4 nos modelos mini, < 1B; do pequeno em
// diante, sem teto: todos os candidatos que passam no corte de relevância, até caberem no contexto).
export const rerankTopN = (fallback: number) => Math.max(1, Math.min(100, Math.round(envNum("RERANK_TOP_N", fallback))));
const modelId = () => (process.env.RERANK_MODEL || "").trim() || DEFAULT_MODEL;
// Arquivo ONNX dentro de onnx/ (sem ".onnx"). O padrão usa a versão int8 publicada por cada repositório.
const modelFile = () => (process.env.RERANK_MODEL_FILE || "").trim() || (modelId() === DEFAULT_MODEL ? "model_quint8_avx2" : "model_int8");
const maxLength = () => Math.max(64, Math.min(1024, Math.round(envNum("RERANK_MAX_LENGTH", 512))));
const rerankDir = () => path.resolve(process.env.RERANK_DIR || path.join(dataDir, "reranker"));

type Loaded = { tokenizer: any; model: any; id: string };
let loaded: Loaded | null = null, loading: Promise<Loaded | null> | null = null, failedAt = 0;
// Execuções em fila: duas perguntas ao mesmo tempo não disputam os mesmos núcleos.
let queue: Promise<unknown> = Promise.resolve();

async function load(): Promise<Loaded | null> {
  const id = modelId(), t0 = Date.now();
  try {
    const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import("@huggingface/transformers");
    env.cacheDir = rerankDir();
    env.allowLocalModels = false;
    if (process.env.RERANK_HF_URL?.trim()) env.remoteHost = `${process.env.RERANK_HF_URL.trim().replace(/\/+$/, "")}/`;
    const threads = envNum("RERANK_THREADS", 0);
    const tokenizer = await AutoTokenizer.from_pretrained(id);
    const model = await AutoModelForSequenceClassification.from_pretrained(id, {
      device: "cpu", dtype: "fp32", model_file_name: modelFile(),
      ...(threads > 0 ? { session_options: { intraOpNumThreads: Math.round(threads), interOpNumThreads: 1 } } : {}),
    });
    console.info(`[Rerank] ${id} (${modelFile()}) carregado em ${Date.now() - t0}ms.`);
    return (loaded = { tokenizer, model, id });
  } catch (e) {
    failedAt = Date.now();
    // fetch failed + UNABLE_TO_GET_ISSUER_CERT_LOCALLY = proxy corporativo com TLS próprio: NODE_EXTRA_CA_CERTS ou copiar o modelo para RERANK_DIR.
    const cause = (e as any)?.cause, detail = cause ? ` (${cause.code || cause.message || cause})` : "";
    console.warn(`[Rerank] não foi possível carregar ${id} em ${rerankDir()}; a busca segue sem reranking: ${e instanceof Error ? e.message : String(e)}${detail}`);
    return null;
  } finally { loading = null; }
}

// Carrega (ou baixa) o modelo. Falhas tentam de novo depois de 10 min (rede de volta, proxy ajustado).
export function prepareReranker(): Promise<Loaded | null> {
  if (!rerankEnabled()) return Promise.resolve(null);
  if (loaded?.id === modelId()) return Promise.resolve(loaded);
  if (loading) return loading;
  if (failedAt && Date.now() - failedAt < 600_000) return Promise.resolve(null);
  return (loading = load());
}

// Pontuação (logit) do Cross-Encoder para cada trecho, na mesma ordem. null = reranking indisponível agora: a pergunta não espera o
// download do modelo, que continua em segundo plano.
export async function rerankScores(query: string, texts: string[]): Promise<number[] | null> {
  if (!rerankEnabled() || !texts.length) return null;
  const ready = loaded?.id === modelId() ? loaded : (void prepareReranker(), null);
  if (!ready) return null;
  // Lotes pequenos de trechos de tamanho parecido: menos preenchimento (padding) e menos memória da arena do ONNX. Medido no container
  // com 25 trechos da base de teste: lote 25 ~1,6 s e +640 MB; lote 4 ~0,8 s e +90 MB.
  const batch = Math.max(1, Math.round(envNum("RERANK_BATCH", 4)));
  const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
  const run = queue.then(async () => {
    const scores = new Array<number>(texts.length);
    for (let s = 0; s < order.length; s += batch) {
      const part = order.slice(s, s + batch);
      const inputs = ready.tokenizer(new Array(part.length).fill(query), { text_pair: part.map(i => texts[i]), padding: true, truncation: true, max_length: maxLength() });
      const { logits } = await ready.model(inputs);
      const width = logits.dims.at(-1) || 1, data = logits.data as Float32Array;
      part.forEach((i, k) => { scores[i] = Number(data[k * width]); });
    }
    return scores;
  });
  queue = run.catch(() => {});
  try { return await run; }
  catch (e) { console.warn("[Rerank] falha ao pontuar; usada a ordem da busca:", e instanceof Error ? e.message : String(e)); return null; }
}

// Corte de relevância, sem número fixo de trechos: fica todo trecho com nota até RERANK_MAX_GAP (logit) abaixo da do melhor; se só um
// é relevante, só ele segue; se 9 são, os 9 seguem (o orçamento de contexto do prompt, em rag.ts, é o limite final). Calibrado na
// base Verdanis (28 perguntas com gabarito, 25 candidatos cada): o teto de 5 + "nota >= 0 sempre fica" recuperava 75% dos trechos
// do gabarito com 57% de precisão e deixava 1 pergunta sem nenhum; só a distância 6 do melhor, sem teto: 84% e 63%, nenhuma sem.
// "Nota >= 0 sempre fica" foi retirado: com o melhor em 10, trazia ruído em 1–2. Piso absoluto também não: linhas de tabela do
// gabarito pontuam -3 a -4 (o Cross-Encoder não lê tabela bem).
export const rerankMaxGap = () => Math.max(0, envNum("RERANK_MAX_GAP", 6));

// Ordem final: casamento exato de código continua na frente (o trecho com "PRJ-ARARA" não pode perder para um parecido); dentro de
// cada faixa vale a pontuação do Cross-Encoder; empate fica com a ordem da busca. Devolve os índices escolhidos, do mais relevante
// para o menos relevante: o melhor e os de código exato sempre; os demais só dentro de maxGap do melhor; no máximo topN.
export function rerankOrder(scores: number[], codeHit: number[], topN: number, maxGap = Infinity): number[] {
  const floor = Math.max(...scores) - maxGap;
  return scores.map((_, i) => i).sort((a, b) => (codeHit[b] || 0) - (codeHit[a] || 0) || scores[b] - scores[a] || a - b)
    .filter((i, k) => k === 0 || (codeHit[i] || 0) > 0 || scores[i] >= floor).slice(0, topN);
}
