import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

// Configuração central de infraestrutura (bancos, caminhos). A IA (servidor Ollama, modelos, contexto, threads) não vem daqui: é
// cadastrada na tela de Configurações e guardada no SQLite (ai.ts, aisettings.ts). Os ajustes finos do RAG (CHUNK_SIZE, RETRIEVAL_TOP_K…)
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
  // Pasta do servidor de onde a importação em lote lê arquivos (no Compose: IMPORT_DIR do host montada só leitura em /app/import).
  get importPath() { return str("IMPORT_PATH", "/app/import"); },
  // Qdrant: recuperação vetorial (densa + esparsa).
  qdrant: {
    url: trimSlash(str("QDRANT_URL", "http://qdrant:6333")),
    apiKey: str("QDRANT_API_KEY"),
    get collection() { return str("QDRANT_COLLECTION", "rag_chunks"); },
    timeoutMs: num("QDRANT_TIMEOUT_MS", 30_000),
    // Quantização dos vetores densos (cópia compacta usada na busca; originais float32 no disco para o rescore):
    //  int8    — 1 byte por dimensão (~1 KB por trecho com bge-m3), a mais precisa (padrão);
    //  binary2 — 2 bits por dimensão (~256 B por trecho, 4x menos RAM que int8);
    //  binary  — 1 bit por dimensão (~128 B por trecho, 8x menos RAM que int8), para bases muito grandes.
    // Trocar vale para a collection existente (o Qdrant reconstrói a quantização em segundo plano, sem reindexar).
    get quantization() { const q = str("QDRANT_QUANTIZATION", "int8").toLowerCase(); return (["int8", "binary", "binary2"].includes(q) ? q : "int8") as "int8" | "binary" | "binary2"; },
    // Vetores quantizados na RAM (rápido). false = no disco (mmap): menos RAM, buscas mais lentas em disco lento.
    get quantizedInRam() { return str("QDRANT_QUANTIZED_IN_RAM", "true") !== "false"; },
    quantile: num("QDRANT_QUANTILE", 0.99),
    // Quantas vezes mais candidatos a busca quantizada pré-seleciona para o rescore com os originais. Binária perde mais
    // precisão na pré-seleção: usa no mínimo 4.
    get oversampling() { const o = num("QDRANT_OVERSAMPLING", 2); return this.quantization === "int8" ? o : Math.max(4, o); },
    hnswEf: num("QDRANT_HNSW_EF", 128),
    onDiskVectors: str("QDRANT_ON_DISK_VECTORS", "true") !== "false",
    // Índice invertido do BM25 em disco (mmap; o cache de páginas do sistema mantém quente o que é usado): a RAM não cresce
    // com o vocabulário da base. false = índice inteiro na RAM.
    get sparseOnDisk() { return str("QDRANT_SPARSE_ON_DISK", "true") !== "false"; },
  },
  // BM25 (vetores esparsos): o Qdrant aplica o IDF (modifier "idf"); a aplicação envia o termo de frequência saturado.
  bm25: { k1: num("BM25_K1", 1.4), b: num("BM25_B", 0.75), avgLen: num("BM25_AVG_DOC_LEN", 80) },
};

// Falha cedo com mensagem clara quando falta algo obrigatório para o servidor.
export function validateConfig() {
  const missing = [
    ["MASTER_USER", str("MASTER_USER")], ["MASTER_PASSWORD", str("MASTER_PASSWORD")],
    ["QDRANT_URL", str("QDRANT_URL")], ["QDRANT_API_KEY", config.qdrant.apiKey],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Variáveis de ambiente obrigatórias ausentes: ${missing.join(", ")}. Veja .env.example.`);
  if (!/^https?:\/\/[^\s/]+/.test(config.qdrant.url)) throw new Error(`QDRANT_URL inválida: "${config.qdrant.url}". Use http://host:porta.`);
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
