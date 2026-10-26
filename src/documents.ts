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
import { embedMany, chunkText, normalizeText } from "./rag.js";

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
    return wb.SheetNames.map(n => `## ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join("\n\n");
  }
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
          const progress = 5 + Math.round(Math.max(0, Math.min(1, message.progress)) * 15);
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
            onProgress?.(5 + Math.round(zip.entriesRead / Math.max(1, zip.entryCount) * 15));
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
    db.prepare("UPDATE documents SET progress=5 WHERE id=?").run(id);
    const content = fixMojibake(text ?? await extractText(filePath!, name, progress => {
      if (filePath) db.prepare("UPDATE documents SET progress=? WHERE id=? AND status='processing'").run(progress, id);
    }));
    const chunks = chunkText(content);
    if (!chunks.length) throw new Error("Nenhum texto foi extraído do documento.");
    const vectors: Buffer[] = [];
    let dims = 0;
    // Lotes evitam uma requisição HTTP por fragmento (PDFs grandes podem ter centenas).
    for (let i = 0; i < chunks.length; i += 32) {
      if (!db.prepare("SELECT 1 FROM documents WHERE id=? AND notebook_id=?").get(id, notebookId)) return;
      const batch = await embedMany(chunks.slice(i, i + 32));
      for (const v of batch) {
        if (!dims) dims = v.length;
        if (v.length !== dims) throw new Error("Dimensão de embedding inconsistente.");
        vectors.push(Buffer.from(new Float32Array(v).buffer));
      }
      db.prepare("UPDATE documents SET progress=? WHERE id=?").run(20 + Math.round(Math.min(i + 32, chunks.length) / chunks.length * 75), id);
    }
    const insert = db.prepare("INSERT INTO chunks(id,document_id,notebook_id,content,embedding,dimensions,chunk_index,search_text) VALUES(?,?,?,?,?,?,?,?)");
    db.exec("BEGIN");
    try {
      if (!db.prepare("SELECT 1 FROM documents WHERE id=? AND notebook_id=?").get(id, notebookId)) {
        db.exec("ROLLBACK");
        return;
      }
      db.prepare("DELETE FROM chunks WHERE document_id=?").run(id);
      chunks.forEach((c, i) => insert.run(crypto.randomUUID(), id, notebookId, c, vectors[i], dims, i, normalizeText(c)));
       db.prepare("UPDATE documents SET status='processed',progress=100,error=NULL WHERE id=?").run(id);
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
  db.prepare("UPDATE documents SET status='processing',progress=2,error=NULL WHERE id=?").run(id);
  try {
    const vectors: { id: string; blob: Buffer; dims: number }[] = [];
    for (let i = 0; i < chunks.length; i += 32) {
      if (!db.prepare("SELECT 1 FROM documents WHERE id=?").get(id)) return;
      const batch = await embedMany(chunks.slice(i, i + 32).map(c => c.content));
      batch.forEach((v, k) => vectors.push({ id: chunks[i + k].id, blob: Buffer.from(new Float32Array(v).buffer), dims: v.length }));
      db.prepare("UPDATE documents SET progress=? WHERE id=?").run(2 + Math.round(vectors.length / chunks.length * 96), id);
    }
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
