import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import pdf from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import yauzl from "yauzl";
import { createWorker, PSM } from "tesseract.js";
import sharp from "sharp";
import { dataDir, db, transaction } from "./database.js";
import { normalizeText } from "./sparse.js";
import { chunkStructured, cleanPdfPages, isTocChunk, stripPageMarkers } from "./chunking.js";
import { csvToMarkdown, rowsToMarkdown, saveRecords } from "./structured.js";
import { chunkPointId, deleteDocumentVectors, embeddingInput, enqueue, indexDocument } from "./indexing.js";

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
    // Mesma montagem de texto do pdf-parse, guardando cada página para limpar cabeçalhos, rodapés e sumário (cleanPdfPages).
    const pages: string[] = [];
    const pagerender = (pageData: any) => pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }).then((content: any) => {
      let lastY: unknown, text = "";
      for (const item of content.items) { text += lastY == item.transform[5] || !lastY ? item.str : `\n${item.str}`; lastY = item.transform[5]; }
      pages.push(text);
      return text;
    });
    await pdf(await fs.readFile(filePath), { pagerender });
    const text = cleanPdfPages(pages);
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
    const langPath = path.resolve(process.env.OCR_DATA_DIR || path.join(dataDir, "ocr-languages"));
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

// Versão do chunking: 1 = estrutural (seções, tabelas com cabeçalho, listas); 2 = PDF limpo (sem cabeçalho/rodapé repetido
// nem sumário, títulos numerados viram seções) e nome do documento no texto do embedding; 3 = página de origem (PDF) nos
// metadados e vetores no Qdrant. "Reprocessar" atualiza documentos antigos.
export const CHUNK_VERSION = 3;
export { embeddingInput };

// Migração sem reindexar: documentos antigos ganham registros estruturados (tabelas/fichas) reextraindo o texto do
// arquivo original, sem recalcular embeddings. Imagens (OCR) ficam de fora por serem caras; roda em segundo plano.
export async function backfillRecords() {
  const docs = db.prepare("SELECT id,notebook_id,path,name,source_text FROM documents WHERE status='processed' AND records_version=0").all() as { id: string; notebook_id: string; path: string | null; name: string; source_text: string | null }[];
  for (const d of docs) {
    try {
      if (/\.(png|jpe?g|webp|bmp|tiff?)$/i.test(d.name)) { db.prepare("UPDATE documents SET records_version=1 WHERE id=?").run(d.id); continue; }
      const text = d.source_text ?? (d.path ? fixMojibake(await extractText(d.path, d.name)) : null);
      if (text == null) { db.prepare("UPDATE documents SET records_version=1 WHERE id=?").run(d.id); continue; }
      const n = saveRecords(d.id, d.notebook_id, stripPageMarkers(text));
      if (n) console.info(`[RAG] ${n} registros estruturados extraídos de "${d.name}"`);
    } catch (e) { console.warn(`[RAG] Não foi possível extrair registros de "${d.name}":`, e instanceof Error ? e.message : String(e)); db.prepare("UPDATE documents SET records_version=1 WHERE id=?").run(d.id); }
    await new Promise(r => setImmediate(r));
  }
}

// Ingestão (fila por documento em indexing.ts; DOCUMENT_PROCESS_CONCURRENCY documentos ao mesmo tempo):
//  1) extrai e normaliza o texto, divide em trechos estruturais;
//  2) grava trechos (IDs determinísticos), registros e metadados no SQLite numa transação → stage 'index';
//  3) gera embeddings (Ollama) e vetores esparsos (BM25) e envia ao Qdrant em lotes, marcando cada lote → 'processed'.
// Se a etapa 3 falhar, o SQLite já tem tudo: a reconciliação ou "Reprocessar" retomam sem duplicar pontos.
export function processDocument(id: string, notebookId: string, filePath: string | null, name: string, text?: string): Promise<void> {
  return enqueue(id, () => processDocumentNow(id, notebookId, filePath, name, text));
}

async function processDocumentNow(id: string, notebookId: string, filePath: string | null, name: string, text?: string) {
  const exists = () => !!db.prepare("SELECT 1 FROM documents WHERE id=? AND notebook_id=?").get(id, notebookId);
  try {
    // O notebook (ou o documento) pode ter sido excluído enquanto o trabalho esperava na fila.
    if (!exists()) return;
    db.prepare("UPDATE documents SET status='processing',stage='extract',progress=0,chunks_done=0,chunks_total=0,error=NULL WHERE id=?").run(id);
    // Texto colado não tem arquivo: o original fica guardado para permitir reprocessar.
    if (text != null) db.prepare("UPDATE documents SET source_text=? WHERE id=?").run(text, id);
    else if (!filePath) text = (db.prepare("SELECT source_text FROM documents WHERE id=?").get(id) as { source_text: string | null } | undefined)?.source_text ?? undefined;
    if (text == null && !filePath) throw new Error("O texto original deste documento não foi guardado; adicione-o novamente.");
    const content = fixMojibake(text ?? await extractText(filePath!, name, progress => {
      if (filePath) db.prepare("UPDATE documents SET progress=? WHERE id=? AND status='processing'").run(progress, id);
    }));
    // Só imagens (OCR) e PPTX reportam progresso de extração; nos demais formatos a indexação ocupa 0–99%.
    const base = filePath && /\.(png|jpe?g|webp|bmp|tiff?|pptx)$/i.test(name) ? 25 : 0;
    const pieces = chunkStructured(content);
    if (!pieces.length) throw new Error("Nenhum texto foi extraído do documento.");
    const stored = transaction(() => {
      if (!exists()) return false;
      db.prepare("DELETE FROM chunks WHERE document_id=?").run(id);
      const insert = db.prepare("INSERT INTO chunks(id,document_id,notebook_id,chunk_index,content,search_text,section,page_start,page_end,toc,indexed) VALUES(?,?,?,?,?,?,?,?,?,?,0)");
      pieces.forEach((c, i) => insert.run(chunkPointId(id, i), id, notebookId, i, c.content, normalizeText(c.content), c.section || null, c.pageStart ?? null, c.pageEnd ?? null, isTocChunk(c.content) ? 1 : 0));
      saveRecords(id, notebookId, stripPageMarkers(content));
      db.prepare("UPDATE documents SET stage='index',progress=?,chunks_done=0,chunks_total=?,chunk_version=? WHERE id=?").run(base, pieces.length, CHUNK_VERSION, id);
      return true;
    });
    if (!stored) return;
    await indexDocument(id, base);
  } catch (e) {
    // indexDocument já registra a própria falha; aqui ficam as falhas de extração/gravação.
    db.prepare("UPDATE documents SET status='failed',error=? WHERE id=? AND status='processing'").run(e instanceof Error ? e.message : String(e), id);
    throw e;
  }
}

// Refaz só os vetores dos trechos já salvos (sem reextrair o arquivo), p.ex. ao trocar o modelo de embeddings.
export function reindexDocument(id: string): Promise<boolean> {
  return enqueue(id, async () => {
    if (!(db.prepare("SELECT count(*) AS n FROM chunks WHERE document_id=?").get(id) as { n: number }).n) return false;
    db.prepare("UPDATE chunks SET indexed=0 WHERE document_id=?").run(id);
    db.prepare("UPDATE documents SET status='processing',stage='index',progress=0,chunks_done=0,error=NULL WHERE id=?").run(id);
    return indexDocument(id);
  });
}

// Exclusão consistente: SQLite primeiro (a busca ignora pontos sem linha no SQLite), depois arquivo e pontos do Qdrant
// (se o Qdrant estiver fora, a exclusão fica pendente e a reconciliação conclui).
export async function removeDocument(id: string) {
  const doc = db.prepare("SELECT path FROM documents WHERE id=?").get(id) as { path: string | null } | undefined;
  if (!doc) return false;
  db.prepare("DELETE FROM documents WHERE id=?").run(id);
  if (doc.path) { try { await fs.unlink(doc.path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error("Falha removendo arquivo:", e); } }
  await deleteDocumentVectors(id);
  return true;
}

// Retoma, na inicialização, o que foi interrompido: extração não concluída vira falha (precisa reprocessar o arquivo);
// indexação no Qdrant interrompida é retomada pela reconciliação a partir do SQLite.
export function recoverInterrupted() {
  db.prepare("UPDATE documents SET status='failed',error='Processamento interrompido; clique em Reprocessar.' WHERE status='processing' AND stage='extract'").run();
}
