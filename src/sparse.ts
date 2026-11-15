// Vetores esparsos BM25 para a busca lexical no Qdrant.
// O Qdrant guarda, por trecho, o peso de frequência do termo (saturação BM25 com normalização pelo tamanho) e multiplica pelo
// IDF calculado por ele mesmo (sparse vector com modifier "idf"). A consulta envia peso 1 para cada termo: o produto escalar
// resultante é exatamente o BM25 clássico. Tudo local: tokenização em português/inglês sem acentos, stopwords e stemming leve.
import { config } from "./config.js";

export const normalizeText = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export const stopWords = new Set(["com", "como", "mais", "menos", "para", "pela", "pelo", "que", "qual", "quais", "quando", "onde", "porque", "sobre", "seus", "suas", "este", "esta", "isso", "essa", "resumidamente", "brevemente", "resumo", "resuma", "resumir", "explique", "defina", "diga", "fale", "simples", "curto", "briefly", "shortly", "summarize", "explain", "the", "and", "for", "from", "what", "when", "where", "which", "this", "that", "with"]);
// Stemming leve (prefixo de 6 letras sem "s" final): "interações"/"interação", "computadores"/"computador".
export const stem = (term: string) => term.replace(/s$/, "").slice(0, 6);
// Recebe texto já normalizado (normalizeText).
export function stemTokens(normalizedText: string): string[] {
  return (normalizedText.match(/[\p{L}\p{N}]{3,}/gu) || []).filter(term => !stopWords.has(term)).map(stem);
}

// Índice do termo no vetor esparso: FNV-1a de 32 bits (o Qdrant aceita índices uint32). Colisões são raras e inofensivas.
export function termIndex(term: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < term.length; i++) { h ^= term.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export type SparseVector = { indices: number[]; values: number[] };
const toSparse = (weights: Map<number, number>): SparseVector => {
  const entries = [...weights].sort((a, b) => a[0] - b[0]);
  return { indices: entries.map(e => e[0]), values: entries.map(e => e[1]) };
};

// Palavras funcionais que só saem do índice BM25 (o roteamento de conversa e a cobertura continuam com stopWords, acima).
// Sem elas, "uma", "dos", "nao" e a preposição "contra" (mesmo radical de "contrato") pesavam como termos de busca.
// Medido (benchmark --retrieval com 1 MB de distratores): índice 10% menor (49,7 contra 55,1 termos por trecho) e MRR
// 0,803 contra 0,799. Palavra inteira ao lado do radical (+55% de índice) e bigramas (+92%) não melhoraram nada e ficaram de fora.
const indexStopWords = new Set([...stopWords, "uma", "umas", "uns", "dos", "das", "nos", "nas", "num", "numa", "por", "pelas", "pelos", "nao", "sao", "ser", "foi", "sera", "tem", "ter", "tambem", "entre", "contra", "ate", "apos", "desde", "sem", "sob", "seu", "sua", "ele", "ela", "eles", "elas", "lhe", "esse", "esses", "essas", "estes", "estas", "aquele", "aquela", "isto", "aquilo", "muito", "muita", "cada", "outro", "outra", "mesmo", "mesma", "ja", "ainda", "apenas", "pois", "porem", "assim", "entao", "are", "was", "were", "has", "have", "had", "not", "but", "all", "any", "can", "will", "its", "into", "than", "then", "there", "their", "them", "these", "those", "which", "who", "how"]);
// Termos do índice: radicais das palavras de conteúdo.
const indexTerms = (normalizedText: string) => (normalizedText.match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => !indexStopWords.has(w)).map(stem);

// Documento: tf saturado = tf·(k1+1) / (tf + k1·(1 − b + b·len/avgLen)). avgLen é fixo (BM25_AVG_DOC_LEN) para que o peso
// de um trecho não dependa do que foi indexado antes (indexação incremental e idempotente).
export function documentSparse(normalizedText: string): SparseVector {
  const terms = indexTerms(normalizedText), length = terms.length;
  const { k1, b, avgLen } = config.bm25;
  const tf = new Map<number, number>();
  for (const t of terms) { const i = termIndex(t); tf.set(i, (tf.get(i) || 0) + 1); }
  const norm = k1 * (1 - b + b * length / Math.max(1, avgLen));
  for (const [i, f] of tf) tf.set(i, Math.round(f * (k1 + 1) / (f + norm) * 1e4) / 1e4);
  return toSparse(tf);
}

// Consulta: cada termo distinto com peso 1 (o IDF vem do Qdrant). Recebe o texto normalizado da pergunta.
export function querySparse(normalizedQuestion: string): SparseVector {
  return toSparse(new Map([...new Set(indexTerms(normalizedQuestion))].map(t => [termIndex(t), 1])));
}
