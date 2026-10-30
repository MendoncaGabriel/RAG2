import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import pdf from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import yauzl from "yauzl";
import { createWorker, PSM } from "tesseract.js";
import sharp from "sharp";
import { db, uploadDir } from "./database.js";
import { embedMany, normalizeText } from "./rag.js";
import { chunkStructured } from "./chunking.js";
import { csvToMarkdown, rowsToMarkdown, saveRecords } from "./structured.js";
import { activeProvider } from "./ai.js";

export function fixMojibake(value: string): string {
  if (!/[ÃÂâð]/.test(value)) return value;
  try {
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    return repaired.includes("\uFFFD") ? value : repaired;
  } catch {
    return value;
  }
}

export async function extractText(filePath: string, name: string, onProgress?: (progress: number) => void): Promise<string> {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".pdf") {
    const text = (await pdf(await fs.readFile(filePath))).text;
    if (text.trim()) return text;
    throw new Error("Este PDF parece ser digitalizado. OCR de PDF ainda requer conversão externa; envie as páginas como imagens.");
  }
  if (ext === ".docx") return (await mammoth.extractRawText({ path: filePath })).value;
  if (ext === ".pptx") return readPptx(filePath, onProgress);
  if (ext === ".xlsx" || ext === ".xls") {
    const wb = XLSX.readFile(filePath);
    // Tabela Markdown (e não CSV) para o chunking repetir o cabeçalho e os registros ficarem consultáveis.
    return wb.SheetNames.map(n => `## ${n}\n${rowsToMarkdown(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: "" }) as unknown[][])}`).join("\n\n");
  }
  if (ext === ".csv") return csvToMarkdown(await fs.readFile(filePath, "utf8"));
  if ([".txt", ".md", ".markdown", ".csv", ".json", ".jsonl", ".js", ".jsx", ".ts", ".tsx", ".py", ".java", ".c", ".cpp", ".h", ".css", ".html", ".htm", ".xml", ".yaml", ".yml", ".toml", ".sql", ".sh", ".bat", ".log", ".ini", ".config", ".env", ".rst", ".tex"].includes(ext)) return fs.readFile(filePath, "utf8");
  if ([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"].includes(ext)) {
    const lang = process.env.OCR_LANG || "por+eng";
    const languages = lang.split("+");
    if (!languages.length || languages.some(item => !["por", "eng"].includes(item))) throw new Error("OCR_LANG aceita por, eng ou por+eng.");
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const langPath = path.resolve(process.env.OCR_DATA_DIR || "./data/ocr-languages");
    await fs.mkdir(langPath, { recursive: true });
    for (const language of languages) {
      const packagePath = require.resolve(`@tesseract.js-data/${language}`);
      const source = path.join(path.dirname(packagePath), "4.0.0", `${language}.traineddata.gz`);
      const target = path.join(langPath, `${language}.traineddata.gz`);
      try { await fs.access(target); } catch { await fs.copyFile(source, target); }
    }
    const preprocessed = await sharp(filePath, { limitInputPixels: 100_000_000 })
      .rotate().flatten({ background: "white" }).resize({ width: 2400, height: 2400, fit: "inside" })
      .grayscale().normalize().sharpen().png().toBuffer();
    const worker = await createWorker(lang, undefined, {
      langPath, gzip: true, cacheMethod: "none",
      logger: message => {
        if (message.status === "recognizing text" && typeof message.progress === "number") {
          const progress = Math.round(Math.max(0, Math.min(1, message.progress)) * 250) / 10;
          db.prepare("UPDATE documents SET progress=? WHERE path=? AND status='processing'").run(progress, filePath);
        }
      },
    });
    try {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: "1", user_defined_dpi: "300" });
      return (await worker.recognize(preprocessed)).data.text;
    } finally { await worker.terminate(); }
  }
  throw new Error("Formato não suportado. Aceitos: PDF, DOCX, PPTX, XLSX/XLS, CSV, TXT, Markdown, JSON, código e imagens (PNG/JPG/TIFF/WebP/BMP).");
}

function readPptx(filePath: string, onProgress?: (progress: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error || new Error("Não foi possível abrir o PPTX."));
      const slides: { name: string; text: string }[] = [];
      zip.on("error", reject);
      zip.on("entry", entry => {
        if (!/^ppt\/slides\/slide\d+\.xml$/.test(entry.fileName)) { zip.readEntry(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError || new Error("Falha ao ler slide."));
          const parts: Buffer[] = [];
          stream.on("data", part => parts.push(part));
          stream.on("error", reject);
          stream.on("end", () => {
            const xml = Buffer.concat(parts).toString("utf8");
            const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => m[1].replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'")).join(" ");
            slides.push({ name: entry.fileName, text });
            onProgress?.(Math.round(zip.entriesRead / Math.max(1, zip.entryCount) * 250) / 10);
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(slides.sort((a,b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(s => `## ${path.basename(s.name, ".xml")}\n${s.text}`).join("\n\n")));
      zip.readEntry();
    });
  });
}

type ProcessingJob = { id: string; notebookId: string; filePath: string | null; name: string; text?: string; resolve: () => void; reject: (error: unknown) => void };
// Trechos por requisição de embedding; menor = barra de progresso mais precisa.
const embedBatch = () => Math.min(64, Math.max(1, Number(process.env.EMBED_BATCH_SIZE) || (activeProvider("embedding")?.kind === "ollama" ? 2 : 8)));
// Provedores hospedados aceitam requisições paralelas; o Ollama local processa uma por vez, então paralelizar só atrapalha.
const embedConcurrency = () => Math.min(6, Math.max(1, Number(process.env.EMBED_CONCURRENCY) || (activeProvider("embedding")?.kind === "ollama" ? 1 : 3)));

// Gera os embeddings em lotes, com lotes em paralelo quando o provedor permite, e grava o progresso real na ordem.
// Retorna null se o documento foi excluído no meio do processamento.
async function embedChunks(texts: string[], id: string, aliveSql: string, aliveArgs: string[], base = 25): Promise<number[][] | null> {
  const EMBED_BATCH = embedBatch();
  const batches = Array.from({ length: Math.ceil(texts.length / EMBED_BATCH) }, (_, i) => texts.slice(i * EMBED_BATCH, (i + 1) * EMBED_BATCH));
  const results: number[][][] = new Array(batches.length);
  const finished = new Array<boolean>(batches.length).fill(false);
  let next = 0, doneBatches = 0, gone = false, failure: unknown;
  const report = () => {
    let ready = 0; while (ready < batches.length && finished[ready]) ready++;
    const done = Math.min(texts.length, ready * EMBED_BATCH);
    // Escala única: extração 0–25%, embeddings 25–95%, gravação 95–100%.
    db.prepare("UPDATE documents SET progress=?,chunks_done=? WHERE id=?").run(Math.round((base + done / texts.length * (95 - base)) * 10) / 10, done, id);
  };
  const worker = async () => {
    while (!gone && failure === undefined) {
      const i = next++;
      if (i >= batches.length) return;
      if (!db.prepare(aliveSql).get(...aliveArgs)) { gone = true; return; }
      try { results[i] = await embedMany(batches[i]); } catch (e) { failure = e; return; }
      finished[i] = true; doneBatches++; report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(embedConcurrency(), batches.length) }, worker));
  if (failure !== undefined) throw failure;
  if (gone) return null;
  const vectors = results.flat();
  if (new Set(vectors.map(v => v.length)).size !== 1) throw new Error("Dimensão de embedding inconsistente.");
  return vectors;
}

// Versão do chunking: 1 = estrutural (seções, tabelas com cabeçalho, listas). Documentos antigos seguem funcionando
// com os trechos que já têm; "Reprocessar" os atualiza.
export const CHUNK_VERSION = 1;

// Migração sem reindexar: documentos antigos ganham registros estruturados (tabelas/fichas) reextraindo o texto do
// arquivo original, sem recalcular embeddings. Imagens (OCR) ficam de fora por serem caras; roda em segundo plano.
export async function backfillRecords() {
  const docs = db.prepare("SELECT id,notebook_id,path,name,source_text FROM documents WHERE status='processed' AND records_version=0").all() as { id: string; notebook_id: string; path: string | null; name: string; source_text: string | null }[];
  for (const d of docs) {
    try {
      if (/\.(png|jpe?g|webp|bmp|tiff?)$/i.test(d.name)) { db.prepare("UPDATE documents SET records_version=1 WHERE id=?").run(d.id); continue; }
      const text = d.source_text ?? (d.path ? fixMojibake(await extractText(d.path, d.name)) : null);
      if (text == null) { db.prepare("UPDATE documents SET records_version=1 WHERE id=?").run(d.id); continue; }
      const n = saveRecords(d.id, d.notebook_id, text);
      if (n) console.info(`[RAG] ${n} registros estruturados extraídos de "${d.name}"`);
    } catch (e) { console.warn(`[RAG] Não foi possível extrair registros de "${d.name}":`, e instanceof Error ? e.message : String(e)); db.prepare("UPDATE documents SET records_version=1 WHERE id=?").run(d.id); }
    await new Promise(r => setImmediate(r));
  }
}

const processingQueue: ProcessingJob[] = [];
let activeJobs = 0;
const processingConcurrency = Math.min(2, Math.max(1, Number(process.env.DOCUMENT_PROCESS_CONCURRENCY) || 1));

export function processDocument(id: string, notebookId: string, filePath: string | null, name: string, text?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    processingQueue.push({ id, notebookId, filePath, name, text, resolve, reject });
    runProcessingQueue();
  });
}

function runProcessingQueue() {
  while (activeJobs < processingConcurrency && processingQueue.length) {
    const job = processingQueue.shift()!;
    activeJobs++;
    void (async () => {
      try { await processDocumentNow(job.id, job.notebookId, job.filePath, job.name, job.text); job.resolve(); }
      catch (error) { job.reject(error); }
      finally { activeJobs--; runProcessingQueue(); }
    })();
  }
}

async function processDocumentNow(id: string, notebookId: string, filePath: string | null, name: string, text?: string) {
  try {
    // A notebook (or document) may have been deleted while this job was queued.
    if (!db.prepare("SELECT 1 FROM documents WHERE id=? AND notebook_id=?").get(id, notebookId)) return;
    db.prepare("UPDATE documents SET progress=0,chunks_done=0,chunks_total=0 WHERE id=?").run(id);
    // Texto colado não tem arquivo: o original fica guardado para permitir reprocessar.
    if (text != null) db.prepare("UPDATE documents SET source_text=? WHERE id=?").run(text, id);
    else if (!filePath) text = (db.prepare("SELECT source_text FROM documents WHERE id=?").get(id) as { source_text: string | null } | undefined)?.source_text ?? undefined;
    if (text == null && !filePath) throw new Error("O texto original deste documento não foi guardado; adicione-o novamente.");
    const content = fixMojibake(text ?? await extractText(filePath!, name, progress => {
      if (filePath) db.prepare("UPDATE documents SET progress=? WHERE id=? AND status='processing'").run(progress, id);
    }));
    // Só imagens (OCR) e PPTX reportam progresso de extração; nos demais formatos os embeddings ocupam 0–95%.
    const base = filePath && /\.(png|jpe?g|webp|bmp|tiff?|pptx)$/i.test(name) ? 25 : 0;
    const pieces = chunkStructured(content), chunks = pieces.map(p => p.content);
    if (!chunks.length) throw new Error("Nenhum texto foi extraído do documento.");
    db.prepare("UPDATE documents SET progress=?,chunks_done=0,chunks_total=? WHERE id=?").run(base, chunks.length, id);
    const embedded = await embedChunks(chunks, id, "SELECT 1 FROM documents WHERE id=? AND notebook_id=?", [id, notebookId], base);
    if (!embedded) return;
    const vectors = embedded.map(v => Buffer.from(new Float32Array(v).buffer)), dims = embedded[0].length;
    const insert = db.prepare("INSERT INTO chunks(id,document_id,notebook_id,content,embedding,dimensions,chunk_index,search_text,section) VALUES(?,?,?,?,?,?,?,?,?)");
    db.exec("BEGIN");
    try {
      if (!db.prepare("SELECT 1 FROM documents WHERE id=? AND notebook_id=?").get(id, notebookId)) {
        db.exec("ROLLBACK");
        return;
      }
      db.prepare("DELETE FROM chunks WHERE document_id=?").run(id);
      pieces.forEach((c, i) => insert.run(crypto.randomUUID(), id, notebookId, c.content, vectors[i], dims, i, normalizeText(c.content), c.section || null));
      saveRecords(id, notebookId, content);
      db.prepare("UPDATE documents SET status='processed',progress=100,error=NULL,chunk_version=? WHERE id=?").run(CHUNK_VERSION, id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (e) {
    db.prepare("UPDATE documents SET status='failed',error=? WHERE id=?").run(e instanceof Error ? e.message : String(e), id);
    throw e;
  }
}

// Refaz só os embeddings dos trechos já salvos (sem reextrair o arquivo), p.ex. ao trocar o modelo de embeddings.
export async function reindexDocument(id: string) {
  const chunks = db.prepare("SELECT id,content FROM chunks WHERE document_id=? ORDER BY chunk_index").all(id) as { id: string; content: string }[];
  if (!chunks.length) return;
  db.prepare("UPDATE documents SET status='processing',progress=0,chunks_done=0,chunks_total=?,error=NULL WHERE id=?").run(chunks.length, id);
  try {
    const embedded = await embedChunks(chunks.map(c => c.content), id, "SELECT 1 FROM documents WHERE id=?", [id], 0);
    if (!embedded) return;
    const vectors = embedded.map((v, k) => ({ id: chunks[k].id, blob: Buffer.from(new Float32Array(v).buffer), dims: v.length }));
    if (new Set(vectors.map(v => v.dims)).size !== 1) throw new Error("Dimensão de embedding inconsistente.");
    const update = db.prepare("UPDATE chunks SET embedding=?,dimensions=? WHERE id=?");
    db.exec("BEGIN");
    try {
      for (const v of vectors) update.run(v.blob, v.dims, v.id);
      db.prepare("UPDATE documents SET status='processed',progress=100,error=NULL WHERE id=?").run(id);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } catch (e) {
    db.prepare("UPDATE documents SET status='failed',error=? WHERE id=?").run(`Falha ao reindexar: ${e instanceof Error ? e.message : String(e)}`, id);
    throw e;
  }
}

export async function removeDocument(id: string) {
  const doc = db.prepare("SELECT path FROM documents WHERE id=?").get(id) as { path: string | null } | undefined;
  if (!doc) return false;
  db.prepare("DELETE FROM documents WHERE id=?").run(id);
  if (doc.path) { try { await fs.unlink(doc.path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error("Falha removendo arquivo:", e); } }
  return true;
}
