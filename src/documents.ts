import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pdf from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { db, uploadDir } from "./database.js";
import { embedMany, chunkText } from "./rag.js";

export function fixMojibake(value: string): string {
  if (!/[ÃÂâð]/.test(value)) return value;
  try {
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    return repaired.includes("\uFFFD") ? value : repaired;
  } catch {
    return value;
  }
}

export async function extractText(filePath: string, name: string): Promise<string> {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".pdf") return (await pdf(await fs.readFile(filePath))).text;
  if (ext === ".docx") return (await mammoth.extractRawText({ path: filePath })).value;
  if (ext === ".xlsx" || ext === ".xls") {
    const wb = XLSX.readFile(filePath);
    return wb.SheetNames.map(n => `## ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join("\n\n");
  }
  if ([".txt", ".md", ".csv"].includes(ext)) return fs.readFile(filePath, "utf8");
  throw new Error("Formato não suportado. Use PDF, DOCX, XLSX, CSV, TXT ou Markdown.");
}

export async function processDocument(id: string, notebookId: string, filePath: string | null, name: string, text?: string) {
  try {
    db.prepare("UPDATE documents SET progress=5 WHERE id=?").run(id);
    const content = fixMojibake(text ?? await extractText(filePath!, name));
    const chunks = chunkText(content);
    if (!chunks.length) throw new Error("Nenhum texto foi extraído do documento.");
    const vectors: Buffer[] = [];
    let dims = 0;
    // Lotes evitam uma requisição HTTP por fragmento (PDFs grandes podem ter centenas).
    for (let i = 0; i < chunks.length; i += 32) {
      const batch = await embedMany(chunks.slice(i, i + 32));
      for (const v of batch) {
        if (!dims) dims = v.length;
        if (v.length !== dims) throw new Error("Dimensão de embedding inconsistente.");
        vectors.push(Buffer.from(new Float32Array(v).buffer));
      }
      db.prepare("UPDATE documents SET progress=? WHERE id=?").run(10 + Math.round(Math.min(i + 32, chunks.length) / chunks.length * 85), id);
    }
    const insert = db.prepare("INSERT INTO chunks(id,document_id,notebook_id,content,embedding,dimensions,chunk_index) VALUES(?,?,?,?,?,?,?)");
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM chunks WHERE document_id=?").run(id);
      chunks.forEach((c, i) => insert.run(crypto.randomUUID(), id, notebookId, c, vectors[i], dims, i));
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

export async function removeDocument(id: string) {
  const doc = db.prepare("SELECT path FROM documents WHERE id=?").get(id) as { path: string | null } | undefined;
  if (!doc) return false;
  db.prepare("DELETE FROM documents WHERE id=?").run(id);
  if (doc.path) { try { await fs.unlink(doc.path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error("Falha removendo arquivo:", e); } }
  return true;
}
