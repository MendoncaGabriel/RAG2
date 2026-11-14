import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

// Configuração central de infraestrutura (bancos, Ollama, caminhos). Os ajustes finos do RAG (CHUNK_SIZE, RETRIEVAL_TOP_K…)
// continuam lidos onde são usados, para que testes e benchmark possam trocá-los por variável de ambiente.
const str = (name: string, fallback = "") => (process.env[name] ?? "").trim() || fallback;
const num = (name: string, fallback: number) => { const v = Number(process.env[name]); return process.env[name]?.trim() && Number.isFinite(v) ? v : fallback; };
const trimSlash = (url: string) => url.replace(/\/+$/, "");

export const config = {
  // SQLite: fonte de verdade de textos, metadados, conversas e estado de indexação.
  sqlitePath: path.resolve(str("SQLITE_PATH", "./volumes/sqlite/database.db")),
  // Arquivos da aplicação: uploads, relatórios, dados de OCR, modelos de voz e ajuste do Ollama.
  dataDir: path.resolve(str("APP_DATA_DIR", "./volumes/app")),
  get uploadDir() { return path.resolve(str("UPLOAD_DIR", path.join(this.dataDir, "uploads"))); },
  // Qdrant: recuperação vetorial (densa + esparsa).
  qdrant: {
    url: trimSlash(str("QDRANT_URL", "http://qdrant:6333")),
    apiKey: str("QDRANT_API_KEY"),
    get collection() { return str("QDRANT_COLLECTION", "rag_chunks"); },
    timeoutMs: num("QDRANT_TIMEOUT_MS", 30_000),
    // Quantização escalar INT8: vetores int8 na RAM; originais (float32) no disco para o rescore.
    quantile: num("QDRANT_QUANTILE", 0.99),
    oversampling: num("QDRANT_OVERSAMPLING", 2),
    hnswEf: num("QDRANT_HNSW_EF", 128),
    onDiskVectors: str("QDRANT_ON_DISK_VECTORS", "true") !== "false",
  },
  // Ollama no Windows 11 (fora do Docker). Modelos separados: LLM e embeddings.
  ollama: {
    baseUrl: trimSlash(str("OLLAMA_BASE_URL")),
    apiKey: str("OLLAMA_API_KEY"),
    llmModel: str("OLLAMA_LLM_MODEL", str("OLLAMA_CHAT_MODEL")),
    embeddingModel: str("OLLAMA_EMBEDDING_MODEL"),
  },
  // BM25 (vetores esparsos): o Qdrant aplica o IDF (modifier "idf"); a aplicação envia o termo de frequência saturado.
  bm25: { k1: num("BM25_K1", 1.4), b: num("BM25_B", 0.75), avgLen: num("BM25_AVG_DOC_LEN", 80) },
};

// Falha cedo com mensagem clara quando falta algo obrigatório para o servidor.
export function validateConfig() {
  const missing = [
    ["MASTER_USER", str("MASTER_USER")], ["MASTER_PASSWORD", str("MASTER_PASSWORD")],
    ["QDRANT_URL", str("QDRANT_URL")], ["QDRANT_API_KEY", config.qdrant.apiKey],
    ["OLLAMA_BASE_URL", config.ollama.baseUrl], ["OLLAMA_LLM_MODEL", config.ollama.llmModel], ["OLLAMA_EMBEDDING_MODEL", config.ollama.embeddingModel],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Variáveis de ambiente obrigatórias ausentes: ${missing.join(", ")}. Veja .env.example.`);
  for (const [name, url] of [["QDRANT_URL", config.qdrant.url], ["OLLAMA_BASE_URL", config.ollama.baseUrl]] as const)
    if (!/^https?:\/\/[^\s/]+/.test(url)) throw new Error(`${name} inválida: "${url}". Use http://host:porta.`);
  if (/\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(config.ollama.baseUrl) && fs.existsSync("/.dockerenv"))
    console.warn(`[Config] OLLAMA_BASE_URL=${config.ollama.baseUrl} aponta para o próprio container. Use o IP do Windows visto pelo WSL2 (scripts/windows/ollama-wsl-bridge.ps1).`);
  warnNetworkFilesystem();
}

// Qdrant e SQLite (WAL) exigem sistema de arquivos local POSIX; montagens do Windows (/mnt/c, 9p/drvfs) não são suportadas.
function warnNetworkFilesystem() {
  try {
    const mounts = fs.readFileSync("/proc/mounts", "utf8").split("\n").map(l => l.split(" ")).filter(p => p.length > 2);
    const dir = path.dirname(config.sqlitePath);
    const mount = mounts.filter(([, target]) => dir === target || dir.startsWith(`${target}/`)).sort((a, b) => b[1].length - a[1].length)[0];
    if (mount && /^(9p|drvfs|cifs|nfs|fuse)/.test(mount[2])) console.warn(`[Config] ${dir} está em ${mount[2]} (montagem do Windows/rede): o SQLite em WAL pode corromper. Coloque VOLUMES_DIR no disco do WSL (ext4).`);
  } catch { /* fora do Linux */ }
}
