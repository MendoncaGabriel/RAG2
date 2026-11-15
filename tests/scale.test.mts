// Escala e qualidade (sem LLM nem Qdrant): índice BM25, resumos por documento guardados, hash de arquivos e migração do schema.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-scale-"));
process.env.SQLITE_PATH = path.join(tmp, "test.sqlite");
process.env.APP_DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, "uploads");
const { db } = await import("../src/database.js");
const { documentSparse, querySparse, normalizeText } = await import("../src/sparse.js");
const { cachedSummary, saveSummary, summaryItems } = await import("../src/summaries.js");
const { fileHash, SUPPORTED_EXTENSIONS } = await import("../src/documents.js");

test("índice BM25: palavras funcionais fora do índice, radicais das palavras de conteúdo", () => {
  const terms = (t: string) => querySparse(normalizeText(t)).indices.length;
  // "contra" (preposição) não pode casar com o radical de "contrato"; "uma", "dos", "nao" não são termos de busca.
  assert.equal(terms("contra uma dos nao"), 0);
  assert.equal(terms("valor do contrato"), 2);
  assert.deepEqual(querySparse(normalizeText("contratos")).indices, querySparse(normalizeText("contrato")).indices);
  const doc = documentSparse(normalizeText("O contrato não vale contra terceiros."));
  assert.equal(doc.indices.length, 3, "contrato, vale, terceiros");
});

test("schema: colunas novas de documentos e índice dos trechos sem vetor denso", () => {
  const cols = (db.prepare("SELECT name FROM pragma_table_info('documents')").all() as { name: string }[]).map(c => c.name);
  assert.ok(cols.includes("content_hash") && cols.includes("external"));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='chunks_dense'").get());
});

test("hash do arquivo em streaming e extensões aceitas", async () => {
  const f = path.join(tmp, "a.txt");
  fs.writeFileSync(f, "abc");
  assert.equal(await fileHash(f), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (const ext of [".pdf", ".docx", ".xlsx", ".md", ".png"]) assert.ok(SUPPORTED_EXTENSIONS.has(ext), ext);
  assert.ok(!SUPPORTED_EXTENSIONS.has(".exe"));
});

test("resumos por documento: guardados, invalidados quando o conteúdo muda e usados no modo resumo", () => {
  db.prepare("INSERT INTO notebooks(id,name) VALUES('nb','N')").run();
  const addDoc = (id: string, name: string, chunks: string[]) => {
    db.prepare("INSERT INTO documents(id,notebook_id,name,type,status) VALUES(?,?,?,'md','processed')").run(id, "nb", name);
    chunks.forEach((c, i) => db.prepare("INSERT INTO chunks(id,document_id,notebook_id,chunk_index,content,search_text) VALUES(?,?,?,?,?,?)").run(`${id}-${i}`, id, "nb", i, c, c));
  };
  addDoc("d1", "Manual.pdf", ["Introdução do manual.", "Capítulo 2."]);
  addDoc("d2", "Política.docx", ["Política de despesas."]);
  addDoc("d3", "Contrato.pdf", ["Cláusula 1."]);
  // Menos da metade com resumo: o modo resumo continua com a amostra de trechos.
  saveSummary("d1", { lead: "Manual de operação da linha A.", bullets: ["Parada exige LOTO-01."] });
  assert.equal(summaryItems("nb"), null);
  saveSummary("d2", { lead: "Política de despesas e reembolso.", bullets: [] });
  const items = summaryItems("nb")!;
  assert.equal(items.length, 3);
  assert.match(items[0].content, /Manual de operação[\s\S]*- Parada exige LOTO-01/);
  assert.equal(items[0].source_type, "document_summary");
  assert.equal(items[2].source_type, "document", "documento sem resumo entra com o trecho inicial");
  // Escopo: só os documentos escolhidos.
  assert.deepEqual(summaryItems("nb", ["d2"])!.map(i => i.document_name), ["Política.docx (resumo do documento)"]);
  // Resumo detalhado não é sobrescrito pelo resumo por amostra; conteúdo novo invalida.
  saveSummary("d1", { lead: "Resumo detalhado.", bullets: [] }, true);
  saveSummary("d1", { lead: "Resumo por amostra.", bullets: [] });
  assert.equal(cachedSummary("d1")!.lead, "Resumo detalhado.");
  db.prepare("UPDATE chunks SET content='Capítulo 2 revisado e ampliado.' WHERE id='d1-1'").run();
  assert.equal(cachedSummary("d1"), null);
});
