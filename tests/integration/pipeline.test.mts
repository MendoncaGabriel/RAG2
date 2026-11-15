// Testes de integração REAIS (sem mocks): Qdrant do docker compose (QDRANT_URL/QDRANT_API_KEY) e Ollama do Windows 11
// (TEST_OLLAMA_URL, TEST_CHAT_MODEL, TEST_EMBEDDING_MODEL; sem URL, o Ollama é detectado). Executar: docker compose --profile test run --rm tests
// Usam uma collection temporária (it_*) e um SQLite temporário; nada dos dados da aplicação é tocado.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-it-"));
process.env.SQLITE_PATH = path.join(tmp, "it.sqlite");
process.env.APP_DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, "uploads");
const collection = `it_${Date.now()}`;
process.env.QDRANT_COLLECTION = collection;

const { db } = await import("../../src/database.js");
const ai = await import("../../src/ai.js");
const qd = await import("../../src/qdrant.js");
const idx = await import("../../src/indexing.js");
const docs = await import("../../src/documents.js");
const rag = await import("../../src/rag.js");
const { config } = await import("../../src/config.js");
// A IA vem das Configurações (SQLite): o teste cadastra o próprio provedor no banco temporário, como a tela faria.
const ollamaUrl = process.env.TEST_OLLAMA_URL || (await ai.detectOllama())[0]?.baseUrl;
if (!ollamaUrl) throw new Error("Ollama não encontrado: defina TEST_OLLAMA_URL (IP do Windows visto pelo WSL2).");
const chatModel = process.env.TEST_CHAT_MODEL || "qwen3:1.7b", embeddingModel = process.env.TEST_EMBEDDING_MODEL || "bge-m3";
const testAi = ai.createProvider({ name: "Ollama teste", kind: "ollama", baseUrl: ollamaUrl, chatModel, embeddingModel });
ai.setActive({ chat: testAi.id, embedding: testAi.id });
const { normalizeText } = await import("../../src/sparse.js");
const corpus = fs.readFileSync(new URL("../fixtures/Base_RAG_Verdanis.md", import.meta.url), "utf8");

const nb = "it-nb", main = "it-doc-main";
const byDoc = (id: string) => ({ must: [{ key: "document_id", match: { value: id } }] });
const sqliteChunks = (id: string) => (db.prepare("SELECT count(*) AS n FROM chunks WHERE document_id=?").get(id) as { n: number }).n;
const docRow = (id: string) => db.prepare("SELECT status,stage,error,embedding_model FROM documents WHERE id=?").get(id) as { status: string; stage: string; error: string | null; embedding_model: string | null } | undefined;
const textOf = (pointId: string) => (db.prepare("SELECT content FROM chunks WHERE id=?").get(pointId) as { content: string } | undefined)?.content ?? "";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, what: string, ms = 240_000) {
  const t = Date.now();
  while (!(await cond())) { if (Date.now() - t > ms) throw new Error(`tempo esgotado esperando: ${what}`); await sleep(500); }
}
async function pointIds(documentId: string) {
  const ids: string[] = [];
  let offset: string | null = null;
  do { const page = await qd.scroll(byDoc(documentId), 256, offset); ids.push(...page.points.map(p => String(p.id))); offset = page.next_page_offset; } while (offset);
  return ids.sort();
}
const addDoc = (id: string, name: string) => db.prepare("INSERT INTO documents(id,notebook_id,name,type,status) VALUES(?,?,?,?,'processing')").run(id, nb, name, "md");
const consistent = async (id: string) => docRow(id)?.status === "processed" && (await qd.count(byDoc(id))) === sqliteChunks(id);

after(async () => {
  await qd.deleteCollection(collection).catch(() => {});
  try { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test("infraestrutura: Ollama do Windows com os modelos e Qdrant da rede interna", async () => {
  const o = await ai.ollamaStatus();
  assert.ok(o.ok, o.error);
  assert.deepEqual(o.models, [chatModel, embeddingModel]);
  assert.ok(await qd.ready(), `Qdrant não respondeu em ${config.qdrant.url}`);
  assert.match(String(await qd.version()), /^1\.\d+\.\d+/);
});

test("ingestão: texto e metadados no SQLite, vetores no Qdrant, IDs consistentes", async () => {
  db.prepare("INSERT INTO notebooks(id,name) VALUES(?,?)").run(nb, "Integração");
  addDoc(main, "Base_RAG_Verdanis.md");
  const t = Date.now();
  await docs.processDocument(main, nb, null, "Base_RAG_Verdanis.md", corpus);
  // Fase 1 (BM25): o documento já está pesquisável por palavras antes dos embeddings.
  const lexicalMs = Date.now() - t;
  assert.equal(docRow(main)!.status, "processed", docRow(main)!.error ?? "");
  const [v] = await ai.embedMany(["porta 4840"], "query");
  const early = await idx.searchCandidates(nb, v, "4840", [], 10);
  assert.ok(early.sparse.length && textOf(String(early.sparse[0].id)).includes("4840"), "BM25 responde antes da busca semântica");
  // Fase 2 (denso, em segundo plano).
  await idx.denseIdle();
  const d = docRow(main)!;
  assert.equal(d.status, "processed", d.error ?? "");
  assert.equal(d.stage, "done");
  assert.equal(d.embedding_model, embeddingModel);
  const chunks = db.prepare("SELECT id,chunk_index,indexed,search_text FROM chunks WHERE document_id=? ORDER BY chunk_index").all(main) as { id: string; chunk_index: number; indexed: number; search_text: string }[];
  assert.ok(chunks.length > 100);
  assert.ok(chunks.every(c => c.indexed === 1 && c.id === idx.chunkPointId(main, c.chunk_index) && c.search_text));
  assert.equal(await qd.count(byDoc(main)), chunks.length);
  assert.deepEqual(await pointIds(main), chunks.map(c => c.id).sort());
  assert.ok((db.prepare("SELECT count(*) AS n FROM records WHERE document_id=?").get(main) as { n: number }).n > 20, "registros estruturados");
  console.info(`  ingestão: ${chunks.length} trechos; pesquisável por BM25 em ${lexicalMs} ms, busca semântica completa em ${Date.now() - t} ms`);
});

test("collection: denso (Cosine) + esparso BM25 (IDF), INT8, multitenancy e índices de payload", async () => {
  const info = (await qd.getCollection())!;
  const p = info.config.params;
  const dims = (await ai.embedMany(["x"]))[0].length;
  assert.equal(p.vectors.dense.size, dims);
  assert.equal(p.vectors.dense.distance, "Cosine");
  assert.equal(p.vectors.dense.on_disk, true);
  assert.equal(p.sparse_vectors.bm25.modifier, "idf");
  assert.equal(p.sparse_vectors.bm25.index?.on_disk, true, "índice BM25 em disco");
  assert.deepEqual(info.config.quantization_config, { scalar: { type: "int8", quantile: 0.99, always_ram: true } });
  assert.equal(info.config.hnsw_config.m, 0);
  assert.equal(info.config.hnsw_config.payload_m, 16);
  for (const [field] of qd.PAYLOAD_INDEXES) assert.ok(info.payload_schema[field], `índice de payload ${field}`);
  assert.equal(info.payload_schema.notebook_id.params?.is_tenant, true);
  // O payload não carrega o texto do trecho (fonte de verdade é o SQLite).
  const [point] = (await qd.scroll(byDoc(main), 1)).points;
  assert.deepEqual(Object.keys(point.payload).sort(), ["chunk_index", "codes", "document_id", "embedding_model", "notebook_id", "source_type", "toc"]);
});

test("busca no Qdrant: densa, esparsa (BM25), por código exato e amostra do notebook", async () => {
  const q = "Qual porta TCP o gateway industrial usa para OPC UA?";
  const [v] = await ai.embedMany([q], "query");
  const c = await idx.searchCandidates(nb, v, normalizeText(q), [], 30);
  assert.ok(c.dense.slice(0, 5).some(p => textOf(String(p.id)).includes("4840")), "densa: trecho da porta 4840 no top 5");
  assert.ok(c.sparse.slice(0, 5).some(p => textOf(String(p.id)).includes("4840")), "esparsa: trecho da porta 4840 no top 5");
  assert.equal(c.sample.length, Math.min(256, sqliteChunks(main)));
  // Só lexical: termo raro sem semântica útil.
  const lex = await idx.searchCandidates(nb, v, "4840", [], 10);
  assert.ok(textOf(String(lex.sparse[0].id)).includes("4840"), "esparsa: termo exato em primeiro");
  const code = await idx.searchCandidates(nb, v, "", ["PRJ-ARARA"], 30);
  assert.ok(code.code.length > 0 && code.code.every(p => textOf(String(p.id)).includes("PRJ-ARARA")), "filtro por código");
  // Outro notebook não enxerga estes trechos.
  const other = await idx.searchCandidates("outro-notebook", v, "4840", [], 10);
  assert.equal(other.dense.length + other.sparse.length + other.sample.length, 0);
  // Escopo por documento: só os documentos escolhidos entram na busca.
  const scoped = await idx.searchCandidates(nb, v, "4840", [], 10, 256, ["outro-documento"]);
  assert.equal(scoped.dense.length + scoped.sparse.length + scoped.sample.length, 0);
  const own = await idx.searchCandidates(nb, v, "4840", [], 10, 256, [main]);
  assert.ok(own.sparse.length > 0 && own.dense.length > 0);
});

test("configuração da collection: quantização e índice BM25 ajustados sem recriar", async () => {
  const before = await qd.count({ must: [{ key: "notebook_id", match: { value: nb } }] });
  process.env.QDRANT_QUANTIZATION = "binary2";
  try {
    assert.ok((await qd.syncCollectionConfig((await qd.getCollection())!)).some(c => /binary2/.test(c)));
    assert.deepEqual((await qd.getCollection())!.config.quantization_config, { binary: { always_ram: true, encoding: "two_bits" } });
    assert.deepEqual(await qd.syncCollectionConfig((await qd.getCollection())!), [], "nada a mudar na segunda vez");
  } finally { delete process.env.QDRANT_QUANTIZATION; }
  await qd.syncCollectionConfig((await qd.getCollection())!);
  assert.deepEqual((await qd.getCollection())!.config.quantization_config, { scalar: { type: "int8", quantile: 0.99, always_ram: true } });
  assert.equal(await qd.count({ must: [{ key: "notebook_id", match: { value: nb } }] }), before, "pontos preservados");
});

test("pipeline RAG completo: busca híbrida → textos do SQLite → LLM do Windows", async () => {
  for (const [q, expected, gold] of [
    ["Qual porta TCP o gateway industrial usa para OPC UA?", /4840/, "4840"],
    ["Quem é o patrocinador do PRJ-ESTUFA?", /caio menezes/i, "PRJ-ESTUFA"],
  ] as const) {
    let retrieved: any[] = [];
    const t = Date.now();
    const r = await rag.ask(nb, q, { onSources: s => { retrieved = s; } });
    assert.match(r.answer, expected, `resposta: ${r.answer}`);
    assert.ok(retrieved.some(s => String(s.excerpt).includes(gold)), "trecho de evidência recuperado");
    assert.ok(r.sources.length > 0, "fontes citadas");
    console.info(`  "${q}" → ${r.answer.slice(0, 80)}… (${Date.now() - t} ms)`);
  }
  // Escopo: perguntando só a outro documento, a resposta não vem deste.
  let scoped: any[] = [];
  await rag.ask(nb, "Qual porta TCP o gateway industrial usa para OPC UA?", { documentIds: ["nao-existe"], retrievalOnly: true, onSources: s => { scoped = s; } });
  assert.ok(scoped.length > 0, "id desconhecido é ignorado: vale o notebook inteiro");
  await rag.ask(nb, "Qual porta TCP o gateway industrial usa para OPC UA?", { documentIds: [main], retrievalOnly: true, onSources: s => { scoped = s; } });
  assert.ok(scoped.some(s => String(s.excerpt).includes("4840")));
});

test("reprocessar é idempotente: mesmos IDs, sem duplicar pontos", async () => {
  const before = await pointIds(main);
  await docs.processDocument(main, nb, null, "Base_RAG_Verdanis.md", corpus);
  assert.deepEqual(await pointIds(main), before);
  assert.equal(await qd.count({ must: [{ key: "notebook_id", match: { value: nb } }] }), before.length);
});

test("atualização: versão menor do documento remove os pontos excedentes", async () => {
  addDoc("it-doc-up", "atualizado.md");
  await docs.processDocument("it-doc-up", nb, null, "atualizado.md", corpus.slice(0, 12_000));
  const n1 = await qd.count(byDoc("it-doc-up"));
  await docs.processDocument("it-doc-up", nb, null, "atualizado.md", corpus.slice(0, 4_000));
  const n2 = await qd.count(byDoc("it-doc-up"));
  assert.ok(n2 < n1, `${n2} < ${n1}`);
  assert.equal(n2, sqliteChunks("it-doc-up"));
});

test("exclusão consistente: SQLite e Qdrant", async () => {
  assert.equal(await docs.removeDocument("it-doc-up"), true);
  assert.equal(sqliteChunks("it-doc-up"), 0);
  assert.equal(await qd.count(byDoc("it-doc-up")), 0);
});

test("Ollama indisponível na indexação: documento pesquisável por BM25; a busca semântica retoma sem duplicar", async () => {
  const bad = ai.createProvider({ name: "offline", kind: "ollama", baseUrl: "http://127.0.0.1:9", embeddingModel });
  ai.setActive({ embedding: bad.id });
  addDoc("it-doc-fail", "falha.md");
  try {
    await docs.processDocument("it-doc-fail", nb, null, "falha.md", corpus.slice(20_000, 32_000));
    await idx.denseIdle();
    assert.match(String(idx.denseStatus().error), /não foi possível conectar/);
  } finally { ai.setActive({ embedding: testAi.id }); ai.deleteProvider(bad.id); }
  const d = docRow("it-doc-fail")!;
  assert.equal(d.status, "processed", "pesquisável por BM25 mesmo sem o Ollama");
  assert.equal(d.stage, "dense", "vetores densos pendentes");
  assert.ok(await consistent("it-doc-fail"), "um ponto por trecho no Qdrant");
  assert.ok(idx.needsSync(), "a verificação periódica vê a pendência");
  const report = await idx.reconcile();
  assert.ok(report.ok, report.error);
  await idx.denseIdle();
  assert.equal(docRow("it-doc-fail")!.stage, "done");
  assert.equal((db.prepare("SELECT count(*) AS n FROM chunks WHERE document_id=? AND indexed<>1").get("it-doc-fail") as { n: number }).n, 0);
  assert.ok(await consistent("it-doc-fail"));
});

test("falha parcial (container caiu no meio): só os trechos pendentes são reenviados", async () => {
  const ids = (db.prepare("SELECT id FROM chunks WHERE document_id=? ORDER BY chunk_index").all("it-doc-fail") as { id: string }[]).map(r => r.id);
  const lost = ids.slice(Math.floor(ids.length / 2));
  await qd.deleteIds(lost);
  db.prepare(`UPDATE chunks SET indexed=0 WHERE id IN (${lost.map(() => "?").join(",")})`).run(...lost);
  db.prepare("UPDATE documents SET status='processing',stage='index' WHERE id=?").run("it-doc-fail");
  const report = await idx.reconcile();
  assert.ok(report.resumedDocuments.includes("it-doc-fail"));
  await waitFor(() => consistent("it-doc-fail"), "indexação parcial retomada");
  assert.deepEqual(await pointIds("it-doc-fail"), [...ids].sort());
  await idx.denseIdle();
  assert.equal(docRow("it-doc-fail")!.stage, "done");
});

test("importação de pasta: lê os arquivos onde estão, ignora repetidos e formatos não suportados", async () => {
  const dir = path.join(tmp, "import"), sub = path.join(dir, "manuais");
  fs.mkdirSync(path.join(sub, "interno"), { recursive: true });
  fs.writeFileSync(path.join(sub, "a.md"), corpus.slice(50_000, 54_000));
  fs.writeFileSync(path.join(sub, "interno", "copia-de-a.md"), corpus.slice(50_000, 54_000));
  fs.writeFileSync(path.join(sub, "foto.xyz"), "x");
  process.env.IMPORT_PATH = dir;
  assert.deepEqual(await docs.importFolders(), ["manuais"]);
  await assert.rejects(docs.importFolder(nb, "../.."), /dentro da pasta de importação/);
  const r = await docs.importFolder(nb, "manuais");
  assert.equal(r.added, 1);
  assert.equal(r.duplicates, 1);
  assert.deepEqual(r.skipped.map(x => x.reason), ["formato não suportado"]);
  const imported = db.prepare("SELECT id,external FROM documents WHERE name='a.md'").get() as { id: string; external: number };
  assert.equal(imported.external, 1);
  await waitFor(() => consistent(imported.id), "arquivo importado indexado");
  assert.equal((await docs.importFolder(nb, "manuais")).duplicates, 2, "importar de novo não duplica");
  // Excluir o documento não apaga o arquivo original do usuário.
  assert.equal(await docs.removeDocument(imported.id), true);
  assert.ok(fs.existsSync(path.join(sub, "a.md")));
});

test("Qdrant indisponível: erro claro na pergunta, exclusão adiada e indexação retomada depois", async () => {
  const realUrl = config.qdrant.url;
  config.qdrant.url = "http://127.0.0.1:1";
  addDoc("it-doc-q", "qdrant-off.md");
  try {
    await assert.rejects(rag.ask(nb, "Qual porta TCP o gateway industrial usa para OPC UA?"), /Qdrant\) indisponível/);
    assert.equal(await docs.removeDocument("it-doc-fail"), true);
    assert.ok((db.prepare("SELECT count(*) AS n FROM vector_deletions").get() as { n: number }).n >= 1, "exclusão pendente registrada");
    await assert.rejects(docs.processDocument("it-doc-q", nb, null, "qdrant-off.md", corpus.slice(40_000, 46_000)), /Qdrant\) indisponível/);
    assert.equal(docRow("it-doc-q")!.stage, "index");
  } finally { config.qdrant.url = realUrl; }
  const report = await idx.reconcile();
  assert.ok(report.ok, report.error);
  assert.ok(report.deferredDeletions >= 1);
  assert.equal(await qd.count(byDoc("it-doc-fail")), 0, "pontos do documento excluído removidos");
  await waitFor(() => consistent("it-doc-q"), "documento indexado após o Qdrant voltar");
});

test("reconciliação: remove órfãos e repara documento com pontos faltando", async () => {
  const dims = (await ai.embedMany(["x"]))[0].length;
  const ghost = idx.pointId("ghost");
  await qd.upsert([{ id: ghost, vector: { dense: Array.from({ length: dims }, (_, i) => (i % 7) / 7) }, payload: { notebook_id: nb, document_id: "ghost-doc", source_type: "document", chunk_index: 0, codes: [], toc: false } }]);
  const victims = (await pointIds(main)).slice(0, 3);
  await qd.deleteIds(victims);
  const report = await idx.reconcile();
  assert.ok(report.orphanDocuments >= 1 && report.orphanPoints >= 1);
  assert.ok(report.repairedDocuments.includes(main));
  await waitFor(() => consistent(main), "documento reparado");
  assert.equal((await qd.retrieve([ghost])).length, 0);
});

test("mensagens salvas: vetor no Qdrant, texto no SQLite, exclusão remove o ponto", async () => {
  db.prepare("INSERT INTO conversations(id,notebook_id) VALUES('it-conv',?)").run(nb);
  db.prepare("INSERT INTO messages(id,conversation_id,role,content) VALUES('it-msg','it-conv','assistant','O cofre azul da sala de servidores usa a combinação 7781-ZETA, definida pela equipe de segurança.')").run();
  db.prepare("INSERT INTO saved_messages(id,notebook_id,message_id,title) VALUES('9b1f0c56-6a35-4c1e-9d4b-0d2f5a0c7e11',?,'it-msg','Cofre azul')").run(nb);
  assert.equal(await idx.indexSavedMessages(nb), 1);
  assert.equal((await qd.retrieve(["9b1f0c56-6a35-4c1e-9d4b-0d2f5a0c7e11"])).length, 1);
  let retrieved: any[] = [];
  await rag.ask(nb, "Qual é a combinação do cofre azul da sala de servidores?", { onSources: s => { retrieved = s; } });
  assert.ok(retrieved.some(s => s.type === "saved_message"), "mensagem salva recuperada pela busca");
  db.prepare("DELETE FROM saved_messages WHERE id='9b1f0c56-6a35-4c1e-9d4b-0d2f5a0c7e11'").run();
  await idx.deletePointVectors(["9b1f0c56-6a35-4c1e-9d4b-0d2f5a0c7e11"]);
  assert.equal((await qd.retrieve(["9b1f0c56-6a35-4c1e-9d4b-0d2f5a0c7e11"])).length, 0);
});

test("modelo de embeddings diferente do índice: a pergunta pede reindexação sem apagar vetores", async () => {
  const set = (v: string) => db.prepare("UPDATE settings SET value=? WHERE key='vector_model'").run(v);
  set("outro-modelo");
  try {
    const r = await rag.ask(nb, "Qual porta TCP o gateway industrial usa para OPC UA?");
    assert.match(r.answer, /Reindexar/);
  } finally { set(embeddingModel); }
  assert.ok((await qd.count(byDoc(main))) > 0);
});

test("Qdrant vazio (volume perdido): índice reconstruído a partir do SQLite", async () => {
  await qd.deleteCollection();
  const r = await rag.ask(nb, "Qual porta TCP o gateway industrial usa para OPC UA?");
  assert.match(r.answer, /reconstruído/);
  await waitFor(async () => (await qd.getCollection()) !== null, "collection recriada");
  await waitFor(() => consistent(main), "documento principal reindexado", 600_000);
  await waitFor(() => consistent("it-doc-q"), "segundo documento reindexado");
  // Reconstruído o BM25, a pergunta já é respondida enquanto a busca semântica ainda está sendo recalculada.
  const again = await rag.ask(nb, "Qual porta TCP o gateway industrial usa para OPC UA?");
  assert.match(again.answer, /4840/);
  await idx.denseIdle();
  assert.equal(idx.densePending(), 0);
});
