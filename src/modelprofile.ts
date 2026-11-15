// Reconhecimento do modelo local e perfil de uso derivado dele. Módulo puro (sem banco nem rede): recebe o nome do modelo e,
// quando o Ollama informa (/api/show), os metadados reais (tamanho, contexto nativo, capacidades). Sem metadados, vale o nome.
// O perfil define parâmetros de geração (temperatura, top_p, top_k, penalidade de repetição, tokens, num_ctx) e de recuperação
// (top-K, tamanho do contexto, vizinhos), para o RAG funcionar bem com qualquer modelo, não só com um específico.

export type ModelInfo = { family?: string; parameterSize?: number; quantization?: string; contextLength?: number; capabilities?: string[] };
export type Tier = "mini" | "pequeno" | "médio" | "grande" | "avançado";
export interface ModelProfile {
  tier: Tier; family: string; sizeB: number; sizeSource: "metadados" | "nome" | "padrão";
  temperature: number; topP: number; topKSampling: number; repeatPenalty: number; maxTokens: number; contextTokens: number;
  topK: number; contextChars: number; neighbors: number;
  // Modelo que só funciona raciocinando (Qwen3-Thinking, DeepSeek-R1, gpt-oss…): não dá para desligar o "pensar", então a saída ganha folga.
  reasoningOnly: boolean;
}

// Modelos abaixo de 2,5B (mini/pequeno) recebem prompt mínimo; do médio em diante usam regras explícitas. Só o mini (< 1B) fica
// com contexto curto e trechos podados.
export const isCompact = (tier: string) => tier === "mini" || tier === "pequeno";

const toBillions = (value: number, unit: string) => (/^m/i.test(unit) ? value / 1000 : value);
// Tamanho no nome: "4b", "1.5b", "e2b" (gemma3n), "270m" (milhões), "8x7b" (mistura de especialistas: total aproximado).
export function sizeFromName(name: string): number | undefined {
  const n = name.toLowerCase();
  const moe = n.match(/(?:^|[^a-z\d.])(\d+)x(\d+(?:\.\d+)?)b(?![a-z])/);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  const b = n.match(/(?:^|[^a-z\d.])e?(\d+(?:\.\d+)?)\s*([bm])(?![a-z])/);
  return b ? toBillions(Number(b[1]), b[2]) : undefined;
}
export const sizeFromDetails = (text: string | undefined): number | undefined => { const m = text?.match(/(\d+(?:\.\d+)?)\s*([BM])/i); return m ? toBillions(Number(m[1]), m[2]) : undefined; };

export function familyOf(name: string, hint = ""): string {
  const n = `${hint} ${name}`.toLowerCase();
  const table: [RegExp, string][] = [[/qwen3/, "qwen3"], [/qwen/, "qwen2"], [/gemma/, "gemma"], [/llama/, "llama"], [/phi/, "phi"], [/mistral|ministral|mixtral/, "mistral"], [/deepseek/, "deepseek"], [/granite/, "granite"], [/smollm/, "smollm"], [/glm/, "glm"], [/gpt-oss/, "gpt-oss"]];
  return table.find(([re]) => re.test(n))?.[1] || "genérico";
}
export const isReasoningOnly = (name: string) => /thinking|deepseek-r1|(^|[^a-z])r1([^a-z\d]|$)|qwq|gpt-oss|magistral/i.test(name);

// Contexto nativo conhecido por família (usado só quando o Ollama não informa). Passar disso degrada ou quebra a resposta.
function nativeContext(name: string, family: string): number | undefined {
  const n = name.toLowerCase();
  if (family === "phi") return /128k|phi3\.5|phi-3\.5|phi4|phi-4/.test(n) ? (/phi4|phi-4/.test(n) ? 16384 : 131072) : 4096;
  if (family === "gemma") return /gemma2/.test(n) ? 8192 : /270m|1b/.test(n) ? 32768 : 131072;
  if (family === "llama") return /llama3(\.\d)?|llama-3/.test(n) ? 131072 : 4096;
  if (family === "qwen3" || family === "qwen2" || family === "mistral") return 32768;
  return undefined;
}

// Amostragem recomendada pelos autores de cada família para respostas factuais (aplicada do médio em diante).
function familySampling(family: string, base: { temperature: number; topP: number; topKSampling: number; repeatPenalty: number }) {
  switch (family) {
    case "qwen3": return { ...base, temperature: Math.max(base.temperature, 0.1), topP: 0.8, topKSampling: 20, repeatPenalty: 1.05 }; // evita decodificação gulosa (laços de repetição)
    case "qwen2": return { ...base, topP: 0.8, topKSampling: 30, repeatPenalty: 1.05 }; // 1.05 é o valor recomendado; maior prejudica a cópia exata de códigos
    case "gemma": return { ...base, topP: 0.95, topKSampling: 64, repeatPenalty: 1.0 };
    case "llama": return { ...base, topP: 0.9, topKSampling: 40, repeatPenalty: 1.05 };
    case "phi": return { ...base, topP: 0.9, topKSampling: 40, repeatPenalty: 1.05 };
    case "mistral": return { ...base, topP: 0.9, topKSampling: 40, repeatPenalty: 1.0 };
    default: return base;
  }
}

// contextOverride (Configurações > Contexto manual): num_ctx fixo no lugar do da faixa, ainda limitado ao contexto nativo do modelo.
export function deriveProfile(name: string, info?: ModelInfo, contextOverride = 0): ModelProfile {
  const metaSize = info?.parameterSize, nameSize = sizeFromName(name);
  const sizeB = metaSize || nameSize || 3, sizeSource = metaSize ? "metadados" : nameSize ? "nome" : "padrão";
  const family = familyOf(name, info?.family);
  let base: Omit<ModelProfile, "family" | "sizeB" | "sizeSource" | "reasoningOnly">;
  if (sizeB < 1) base = { tier: "mini", temperature: 0, topP: 0.7, topKSampling: 20, repeatPenalty: 1.2, maxTokens: 400, contextTokens: 3072, topK: 2, contextChars: 2_500, neighbors: 0 };
  // 1–2,5B (Qwen3.5-2B, qwen3:1.7b): o reranking já filtra o ruído, então o modelo recebe passagens inteiras dos 5 melhores, com os
  // vizinhos dos 2 primeiros (≈8000 caracteres, ~2500–3000 tokens). Contexto de 8192 deixa folga para histórico e resposta detalhada.
  // Com GPU (~600 tokens/s de preenchimento medidos no PC de referência) isso custa ~5 s antes da 1ª palavra.
  else if (sizeB < 2.5) base = { tier: "pequeno", temperature: 0, topP: 0.8, topKSampling: 30, repeatPenalty: 1.1, maxTokens: 700, contextTokens: 8192, topK: 5, contextChars: 8_000, neighbors: 2 };
  // 3–4B: mesma lógica, com mais folga de saída.
  else if (sizeB < 6) base = { tier: "médio", temperature: 0, topP: 0.8, topKSampling: 30, repeatPenalty: 1.05, maxTokens: 1024, contextTokens: 8192, topK: 5, contextChars: 9_000, neighbors: 2 };
  else if (sizeB < 14) base = { tier: "grande", temperature: 0.1, topP: 0.9, topKSampling: 40, repeatPenalty: 1.05, maxTokens: 1536, contextTokens: 12288, topK: 8, contextChars: 12_000, neighbors: 2 };
  else base = { tier: "avançado", temperature: 0.1, topP: 0.9, topKSampling: 40, repeatPenalty: 1.05, maxTokens: 2048, contextTokens: 16384, topK: 9, contextChars: 16_000, neighbors: 2 };
  // Amostragem da família do pequeno em diante. Qwen3/Qwen3.5 não devem usar decodificação gulosa (laços de repetição), e a
  // penalidade 1.05 (no lugar de 1.1) atrapalha menos a cópia exata de códigos e valores.
  if (base.tier !== "mini") Object.assign(base, familySampling(family, base));
  if (contextOverride >= 2048) base.contextTokens = Math.round(contextOverride);
  // Contexto nunca acima do que o modelo suporta; o texto recuperado encolhe junto (≈2,5 caracteres por token, com folga para prompt e resposta).
  const native = info?.contextLength || nativeContext(name, family);
  if (native && native < base.contextTokens) {
    base.contextTokens = Math.max(2048, native);
    base.contextChars = Math.min(base.contextChars, Math.max(1_500, Math.round((base.contextTokens - 1_200) * 2.5)));
  }
  return { ...base, family, sizeB, sizeSource, reasoningOnly: isReasoningOnly(name) };
}

// Prefixos de consulta/documento que modelos de embeddings exigem para recuperar bem (sem eles a busca perde qualidade).
export function embeddingPrefix(model: string, kind: "query" | "document"): string {
  const m = model.toLowerCase();
  if (m.includes("nomic")) return kind === "query" ? "search_query: " : "search_document: ";
  if (/e5/.test(m)) return kind === "query" ? "query: " : "passage: ";
  if (/mxbai-embed|snowflake-arctic-embed/.test(m)) return kind === "query" ? "Represent this sentence for searching relevant passages: " : "";
  if (/qwen3-embedding/.test(m)) return kind === "query" ? "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: " : "";
  if (/embeddinggemma/.test(m)) return kind === "query" ? "task: search result | query: " : "title: none | text: ";
  return "";
}
