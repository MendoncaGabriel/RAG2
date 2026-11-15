// Sincronização SQLite (fonte de verdade) ↔ Qdrant (índice de busca). Não há transação distribuída, então:
// - IDs determinísticos: o ponto do trecho N do documento D é sempre o mesmo UUID; reprocessar/reindexar sobrescreve, não duplica.
// - Duas fases: os trechos são gravados no SQLite (stage='index', indexed=0) e só então vetorizados e enviados ao Qdrant em lotes;
//   cada lote confirmado marca indexed=1. Falha no meio (Ollama/Qdrant fora, container reiniciado) retoma do que falta.
// - O documento só fica 'processed' depois que todos os trechos estão no Qdrant.
// - Exclusões: primeiro no SQLite (a busca ignora pontos sem linha no SQLite), depois no Qdrant; se o Qdrant falhar, a exclusão
//   fica pendente em vector_deletions e a reconciliação tenta de novo.
// - reconcile(): compara contagens por documento (facet do Qdrant) com o SQLite, remove órfãos, reindexa o que divergir e retoma
//   indexações interrompidas. Também reconstrói o Qdrant inteiro a partir do SQLite se a collection sumir.
import crypto from "node:crypto";
import { config } from "./config.js";
import { db, transaction } from "./database.js";
import { activeProvider, embedMany } from "./ai.js";
import * as qdrant from "./qdrant.js";
import { documentSparse, normalizeText, querySparse, type SparseVector } from "./sparse.js";
import { extractCodes } from "./structured.js";

// ---------- IDs ----------
// UUID determinístico (formato v5) a partir de uma chave.
export function pointId(key: string): string {
  const h = crypto.createHash("sha1").update(key).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
export const chunkPointId = (documentId: string, index: number) => pointId(`chunk:${documentId}:${index}`);

// O vetor do trecho leva o nome do documento ("Hefesto - Technical Manual"): o trecho solto ganha o assunto do documento e
// perguntas que citam o sistema ou o tipo de documento acham o trecho certo. O conteúdo salvo e enviado ao modelo não muda.
export const embeddingInput = (name: string, content: string) => {
  const title = name.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/_+/g, " ").trim();
  return title ? `Documento: ${title}\n${content}` : content;
};

// ---------- Collection e modelo de embeddings ----------
const getSetting = (key: string) => (db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value || "";
const setSetting = (key: string, value: string) => { db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); };
// Modelo de embeddings que gerou os vetores da collection atual (vazio = collection ainda não criada por este banco).
export const vectorModel = () => getSetting("vector_model");
export const activeEmbeddingModel = () => activeProvider("embedding")?.embeddingModel || "";

export class ModelMismatchError extends Error {}
let ensured: { collection: string; model: string; dims: number } | null = null;
let ensuring: Promise<{ model: string; dims: number; created: boolean }> | null = null;

// Garante a collection para o modelo de embeddings ativo. Criar uma collection ausente é sempre permitido; recriar (apagar os
// vetores de outro modelo) só quando allowRecreate (processar/reindexar documentos), nunca numa pergunta.
export async function ensureCollection(allowRecreate = false): Promise<{ model: string; dims: number; created: boolean }> {
  const model = activeEmbeddingModel();
  if (!model) throw new Error("Nenhuma IA de embeddings selecionada. Escolha uma em Configurações.");
  const collection = config.qdrant.collection;
  if (ensured && ensured.model === model && ensured.collection === collection) return { ...ensured, created: false };
  while (ensuring) await ensuring.catch(() => {});
  if (ensured && ensured.model === model && ensured.collection === collection) return { ...ensured, created: false };
  ensuring = (async () => {
    const info = await qdrant.getCollection();
    const stored = vectorModel(), size = qdrant.denseSize(info);
    if (info && size && (stored === model || !stored)) {
      // Banco SQLite novo com a collection já existente (mesma dimensão): adota; a reconciliação remove os órfãos.
      if (!stored) { const dims = (await embedMany(["dimensão"], "document"))[0].length; if (dims !== size) return recreate(model, dims, info, allowRecreate); setSetting("vector_model", model); }
      // Quantização/índice BM25 configurados diferentes dos da collection: ajusta sem recriar (uma falha só gera aviso).
      try { const changes = await qdrant.syncCollectionConfig(info); if (changes.length) console.info(`[Qdrant] collection "${collection}" ajustada: ${changes.join(", ")} (o Qdrant reconstrói em segundo plano).`); }
      catch (e) { console.warn(`[Qdrant] não foi possível ajustar a configuração da collection: ${e instanceof Error ? e.message : e}`); }
      ensured = { collection, model, dims: size };
      return { model, dims: size, created: false };
    }
    const dims = (await embedMany(["dimensão"], "document"))[0].length;
    return recreate(model, dims, info, allowRecreate);
  })().finally(() => { ensuring = null; });
  return ensuring;
}
async function recreate(model: string, dims: number, info: qdrant.CollectionInfo | null, allowRecreate: boolean) {
  const collection = config.qdrant.collection;
  if (info) {
    if (!allowRecreate) throw new ModelMismatchError(`O modelo de embeddings ativo (${model}) é diferente do usado no índice (${vectorModel() || "desconhecido"}). Use "Reindexar" no notebook.`);
    console.warn(`[Qdrant] recriando a collection "${collection}" para o modelo ${model} (${dims} dimensões); documentos de outros modelos precisam ser reindexados.`);
    await qdrant.deleteCollection();
  }
  await qdrant.createCollection(dims);
  // Nada está no Qdrant agora: tudo volta a "pendente". Documentos do mesmo modelo são reconstruídos pela reconciliação.
  transaction(() => { db.exec("UPDATE chunks SET indexed=0"); db.exec("UPDATE saved_messages SET indexed=0"); });
  setSetting("vector_model", model);
  setSetting("sparse_version", SPARSE_VERSION);
  ensured = { collection, model, dims };
  console.info(`[Qdrant] collection "${collection}" criada: dense ${dims}d (Cosine, quantização ${config.qdrant.quantization}, originais em disco) + bm25 esparso (IDF, índice ${config.qdrant.sparseOnDisk ? "em disco" : "na RAM"}).`);
  return { model, dims, created: true };
}
// Upsert com nova tentativa se a collection sumiu (volume do Qdrant apagado com a aplicação no ar).
async function upsertPoints(points: qdrant.Point[]) {
  try { await qdrant.upsert(points); }
  catch (e) {
    if (!(e instanceof qdrant.QdrantError) || !/ 404 /.test(e.message)) throw e;
    ensured = null;
    await ensureCollection();
    await qdrant.upsert(points);
  }
}

// ---------- Fila de trabalhos por documento ----------
// Um documento nunca é processado por dois trabalhos ao mesmo tempo; a concorrência global vem de DOCUMENT_PROCESS_CONCURRENCY.
type Job = { key: string; run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void; promise: Promise<unknown> };
const queue: Job[] = [], running = new Set<string>();
const concurrency = () => Math.min(4, Math.max(1, Number(process.env.DOCUMENT_PROCESS_CONCURRENCY) || 1));
export const isBusy = (documentId: string) => running.has(documentId) || queue.some(j => j.key === documentId);
export function enqueue<T>(documentId: string, run: () => Promise<T>, dedupe = false): Promise<T> {
  const pending = dedupe ? queue.find(j => j.key === documentId) : undefined;
  if (pending) return pending.promise as Promise<T>;
  let resolve!: (v: unknown) => void, reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
  queue.push({ key: documentId, run, resolve, reject, promise });
  pump();
  return promise as Promise<T>;
}
function pump() {
  while (running.size < concurrency()) {
    const i = queue.findIndex(j => !running.has(j.key));
    if (i < 0) return;
    const [job] = queue.splice(i, 1);
    running.add(job.key);
    job.run().then(job.resolve, job.reject).finally(() => { running.delete(job.key); pump(); });
  }
}

// ---------- Indexação ----------
const embedBatch = () => Math.min(64, Math.max(1, Number(process.env.EMBED_BATCH_SIZE) || 8));
const alive = (documentId: string) => !!db.prepare("SELECT 1 FROM documents WHERE id=?").get(documentId);

// Embeddings em lote; trechos idênticos (cabeçalhos repetidos, tabelas) são calculados uma vez só.
async function embedUnique(texts: string[]): Promise<number[][]> {
  const unique = [...new Set(texts)];
  const vectors = await embedMany(unique, "document");
  const byText = new Map(unique.map((t, i) => [t, vectors[i]]));
  return texts.map(t => byText.get(t)!);
}
type ChunkRow = { id: string; chunk_index: number; content: string; search_text: string; section: string | null; page_start: number | null; page_end: number | null; toc: number };
const chunkPayload = (notebookId: string, documentId: string, c: ChunkRow, model: string) => ({
  notebook_id: notebookId, document_id: documentId, source_type: "document", chunk_index: c.chunk_index,
  codes: extractCodes(c.content), toc: !!c.toc, embedding_model: model, ...(c.page_start ? { page: c.page_start } : {}),
});
// Versão do vetor BM25 (tokenização/stopwords de sparse.ts). Mudou: a reconciliação regrava só o vetor esparso dos pontos
// existentes (sem Ollama, milhares de trechos por segundo), sem tocar no denso.
const SPARSE_VERSION = "2";
async function refreshSparse(): Promise<number> {
  if (getSetting("sparse_version") === SPARSE_VERSION) return 0;
  let done = 0;
  const update = async (points: { id: string; vector: Record<string, any> }[]) => {
    try { await qdrant.updateVectors(points); }
    catch (e) {
      if (!(e instanceof qdrant.QdrantError) || !/ 404 /.test(e.message)) throw e;
      for (const p of points) await qdrant.updateVectors([p]).catch(err => { if (!(err instanceof qdrant.QdrantError) || !/ 404 /.test(err.message)) throw err; });
    }
  };
  const page = db.prepare("SELECT rowid,id,search_text FROM chunks WHERE indexed<>0 AND rowid>? ORDER BY rowid LIMIT 512");
  for (let last = 0; ;) {
    const rows = page.all(last) as { rowid: number; id: string; search_text: string }[];
    if (!rows.length) break;
    await update(rows.map(r => ({ id: r.id, vector: { [qdrant.SPARSE]: documentSparse(r.search_text) } })));
    last = rows[rows.length - 1].rowid; done += rows.length;
  }
  const saved = db.prepare("SELECT s.id,m.content FROM saved_messages s JOIN messages m ON m.id=s.message_id WHERE s.indexed=1").all() as { id: string; content: string }[];
  for (let i = 0; i < saved.length; i += 512) await update(saved.slice(i, i + 512).map(r => ({ id: r.id, vector: { [qdrant.SPARSE]: documentSparse(normalizeText(r.content)) } })));
  setSetting("sparse_version", SPARSE_VERSION);
  return done + saved.length;
}
const sparseOf = (normalized: string): Record<string, SparseVector> => { const s = documentSparse(normalized); return s.indices.length ? { [qdrant.SPARSE]: s } : {}; };

// Indexação em duas fases (a busca por palavras fica pronta em segundos; a semântica chega depois):
//  1) BM25 (indexDocument): os trechos pendentes (indexed=0) vão ao Qdrant só com o vetor esparso e o payload, em lotes grandes,
//     sem chamar o Ollama → indexed=2 e o documento já fica 'processed' (pesquisável), com stage='dense'.
//  2) Denso (worker em segundo plano, um por processo): calcula os embeddings dos trechos com indexed=2, em ordem de chegada dos
//     documentos, e atualiza só o vetor denso do ponto → indexed=1; sem pendências o documento passa a stage='done'.
//     O worker cede a vez às perguntas (o embedding da pergunta não espera atrás de uma fila de lotes) e para quando o
//     Ollama/Qdrant caem; a reconciliação periódica o retoma. Enquanto o denso não chega, a busca usa o BM25 + reranking.
const LEXICAL_BATCH = 256;
// base: progresso já usado pela extração (0–25%). Retorna false se o documento foi excluído no meio.
export async function indexDocument(documentId: string, base = 0): Promise<boolean> {
  const doc = db.prepare("SELECT notebook_id,name FROM documents WHERE id=?").get(documentId) as { notebook_id: string; name: string } | undefined;
  if (!doc) return false;
  try {
    const { model } = await ensureCollection(true);
    const total = (db.prepare("SELECT count(*) AS n FROM chunks WHERE document_id=?").get(documentId) as { n: number }).n;
    if (!total) throw new Error("Nenhum trecho para indexar; use Reprocessar.");
    db.prepare("UPDATE documents SET status='processing',stage='index',error=NULL,chunks_total=? WHERE id=?").run(total, documentId);
    // Versão anterior do documento com mais trechos: os pontos excedentes saem (os demais são sobrescritos pelo mesmo ID).
    await qdrant.deleteByFilter({ must: [{ key: "document_id", match: { value: documentId } }, { key: "chunk_index", range: { gte: total } }] });
    const pending = db.prepare("SELECT id,chunk_index,content,search_text,section,page_start,page_end,toc FROM chunks WHERE document_id=? AND indexed=0 ORDER BY chunk_index").all(documentId) as ChunkRow[];
    let done = total - pending.length;
    const progress = db.prepare("UPDATE documents SET progress=?,chunks_done=? WHERE id=?");
    const mark = db.prepare("UPDATE chunks SET indexed=2 WHERE id=? AND indexed=0");
    progress.run(Math.round((base + done / total * (99 - base)) * 10) / 10, done, documentId);
    for (let i = 0; i < pending.length; i += LEXICAL_BATCH) {
      if (!alive(documentId)) break;
      const batch = pending.slice(i, i + LEXICAL_BATCH);
      await upsertPoints(batch.map(c => ({ id: c.id, vector: sparseOf(c.search_text), payload: chunkPayload(doc.notebook_id, documentId, c, model) })));
      transaction(() => { for (const c of batch) mark.run(c.id); });
      done += batch.length;
      progress.run(Math.round((base + done / total * (99 - base)) * 10) / 10, done, documentId);
    }
    // Excluído durante a indexação: os pontos já enviados saem do Qdrant.
    if (!alive(documentId)) { await deleteDocumentVectors(documentId); return false; }
    const left = (db.prepare("SELECT count(*) AS n FROM chunks WHERE document_id=? AND indexed=0").get(documentId) as { n: number }).n;
    if (left) throw new Error(`${left} trecho(s) não foram indexados.`);
    // Pesquisável por BM25: a interface mostra o avanço da busca semântica (chunks_done = trechos com vetor denso).
    const dense = (db.prepare("SELECT count(*) AS n FROM chunks WHERE document_id=? AND indexed=1").get(documentId) as { n: number }).n;
    db.prepare("UPDATE documents SET status='processed',stage=?,progress=100,chunks_done=?,error=NULL,embedding_model=?,indexed_at=datetime('now') WHERE id=?").run(dense < total ? "dense" : "done", dense, model, documentId);
    kickDense();
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    db.prepare("UPDATE documents SET status='failed',error=? WHERE id=?").run(`Falha na indexação (os trechos estão salvos; será retomada quando o serviço voltar ou com Reprocessar): ${message}`, documentId);
    throw e;
  }
}

// ---------- Vetores densos em segundo plano ----------
let denseLoop: Promise<void> | null = null, denseAgain = false, denseError = "";
const denseWaiters: (() => void)[] = [];
// Perguntas em andamento: o worker espera entre lotes para o embedding da pergunta não disputar o Ollama com a indexação.
let asking = 0;
export async function withQuestion<T>(run: () => Promise<T>): Promise<T> { asking++; try { return await run(); } finally { asking--; } }
// Tarefas longas de LLM (One page) esperam as perguntas em andamento terminarem para não atrasar o chat.
export const questionInProgress = () => asking > 0;
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
export const densePending = () => (db.prepare("SELECT count(*) AS n FROM chunks WHERE indexed=2").get() as { n: number }).n;
export const denseStatus = () => ({ running: !!denseLoop, pending: densePending(), error: denseError || undefined });
// Inicia o worker (se não estiver rodando). Seguro chamar a qualquer momento.
export function kickDense() {
  if (denseLoop) { denseAgain = true; return; }
  denseLoop = runDense().catch(e => { denseError = e instanceof Error ? e.message : String(e); console.warn(`[Indexação] busca semântica pausada: ${denseError}. Será retomada na próxima sincronização.`); })
    .finally(() => { denseLoop = null; if (denseAgain && !denseError) { denseAgain = false; kickDense(); } else { denseAgain = false; while (denseWaiters.length) denseWaiters.shift()!(); } });
}
// Resolve quando não há mais trechos sem vetor denso (ou o worker parou por erro). Usado pelos testes e pelo benchmark.
export function denseIdle(): Promise<void> {
  if (!denseLoop && !densePending()) return Promise.resolve();
  if (!denseLoop) kickDense();
  return new Promise(r => denseWaiters.push(r));
}
type DenseRow = { id: string; document_id: string; content: string; name: string };
async function runDense() {
  denseError = "";
  const next = db.prepare(`SELECT c.id,c.document_id,c.content,d.name FROM chunks c JOIN documents d ON d.id=c.document_id
    WHERE c.indexed=2 AND d.status='processed' AND d.embedding_model=? ORDER BY d.created_at,c.document_id,c.chunk_index LIMIT ?`);
  const mark = db.prepare("UPDATE chunks SET indexed=1 WHERE id=? AND indexed=2 AND content=?");
  const finish = db.prepare(`UPDATE documents SET chunks_done=(SELECT count(*) FROM chunks c WHERE c.document_id=documents.id AND c.indexed=1),
    stage=CASE WHEN EXISTS(SELECT 1 FROM chunks c WHERE c.document_id=documents.id AND c.indexed<>1) THEN stage ELSE 'done' END WHERE id=? AND status='processed' AND stage='dense'`);
  for (;;) {
    while (asking > 0) await pause(150);
    // Só trechos de documentos do modelo de embeddings ativo: os de outro modelo esperam o "Reindexar" (nunca misturar modelos).
    if (!db.prepare("SELECT 1 FROM chunks WHERE indexed=2 LIMIT 1").get()) return;
    const { model, dims } = await ensureCollection(false);
    const batch = next.all(model, embedBatch()) as DenseRow[];
    if (!batch.length) return;
    const vectors = await embedUnique(batch.map(r => embeddingInput(r.name, r.content)));
    if (vectors.some(v => v.length !== dims)) throw new Error(`Dimensão de embedding inconsistente (esperado ${dims}). O modelo ${model} mudou?`);
    const points = batch.map((r, k) => ({ id: r.id, vector: { [qdrant.DENSE]: vectors[k] } }));
    try { await qdrant.updateVectors(points); }
    catch (e) {
      // Documento excluído/reprocessado no meio do lote: o ponto sumiu. Atualiza um a um e ignora os que não existem mais.
      if (!(e instanceof qdrant.QdrantError) || !/ 404 /.test(e.message)) throw e;
      for (const p of points) await qdrant.updateVectors([p]).catch(err => { if (!(err instanceof qdrant.QdrantError) || !/ 404 /.test(err.message)) throw err; });
    }
    // Só marca se o trecho não mudou enquanto o embedding era calculado (reprocessamento): senão ele volta na próxima volta.
    transaction(() => { for (const r of batch) mark.run(r.id, r.content); for (const id of new Set(batch.map(r => r.document_id))) finish.run(id); });
  }
}

// Mensagens salvas pendentes do notebook entram no Qdrant (o texto continua só no SQLite).
export async function indexSavedMessages(notebookId: string, allowRecreate = false) {
  const pending = db.prepare("SELECT s.id,m.content FROM saved_messages s JOIN messages m ON m.id=s.message_id WHERE s.notebook_id=? AND s.indexed=0").all(notebookId) as { id: string; content: string }[];
  if (!pending.length) return 0;
  const { model } = await ensureCollection(allowRecreate);
  const mark = db.prepare("UPDATE saved_messages SET indexed=1,embedding_model=?,index_error=NULL WHERE id=?");
  for (let i = 0; i < pending.length; i += 16) {
    const batch = pending.slice(i, i + 16);
    const vectors = await embedMany(batch.map(r => r.content), "document");
    await upsertPoints(batch.map((r, k) => ({ id: r.id, vector: { [qdrant.DENSE]: vectors[k], ...sparseOf(normalizeText(r.content)) }, payload: { notebook_id: notebookId, source_type: "saved_message", chunk_index: 0, codes: extractCodes(r.content), toc: false, embedding_model: model } })));
    transaction(() => { for (const r of batch) mark.run(model, r.id); });
  }
  return pending.length;
}

// ---------- Exclusão ----------
async function deleteOrDefer(kind: "document" | "notebook" | "point", ref: string) {
  try {
    if (kind === "point") await qdrant.deleteIds([ref]);
    else await qdrant.deleteByFilter({ must: [{ key: kind === "document" ? "document_id" : "notebook_id", match: { value: ref } }] });
  } catch (e) {
    console.warn(`[Qdrant] exclusão de ${kind} ${ref} adiada: ${e instanceof Error ? e.message : String(e)}`);
    db.prepare("INSERT INTO vector_deletions(kind,ref) VALUES(?,?)").run(kind, ref);
  }
}
export const deleteDocumentVectors = (documentId: string) => deleteOrDefer("document", documentId);
export const deleteNotebookVectors = (notebookId: string) => deleteOrDefer("notebook", notebookId);
export const deletePointVectors = (ids: string[]) => Promise.all(ids.map(id => deleteOrDefer("point", id)));

// ---------- Busca (candidatos) ----------
const notebookFilter = (notebookId: string, extra: unknown[] = [], mustNot: unknown[] = []) => ({ must: [{ key: "notebook_id", match: { value: notebookId } }, ...extra], ...(mustNot.length ? { must_not: mustNot } : {}) });
const notToc = [{ key: "toc", match: { value: true } }];
export type Candidates = { dense: qdrant.ScoredPoint[]; sparse: qdrant.ScoredPoint[]; code: qdrant.ScoredPoint[]; sample: number[] };
// Uma ida ao Qdrant (query/batch) com até quatro buscas no notebook:
//  dense  — similaridade semântica (HNSW sobre INT8 + rescore com os vetores originais);
//  sparse — BM25 (vetor esparso, IDF do Qdrant);
//  code   — trechos que contêm os códigos exatos citados (índice de payload "codes"), ordenados pela similaridade;
//  sample — amostra aleatória re-pontuada pela similaridade: estima média e desvio do notebook para o z-score da relevância.
// Sumários (toc) ficam fora das listas densa e esparsa, como antes; entram só por código exato.
// scope: só estes documentos (o usuário escolheu em quais documentos perguntar); vazio = o notebook inteiro.
const scopeFilter = (scope?: string[] | null) => scope?.length ? [{ key: "document_id", match: { any: scope } }] : [];
export async function searchCandidates(notebookId: string, dense: number[], lexicalQuery: string, codes: string[], pool: number, sampleSize = 256, scope?: string[] | null): Promise<Candidates> {
  const params = qdrant.searchParams(), inScope = scopeFilter(scope);
  const searches: unknown[] = [
    { query: dense, using: qdrant.DENSE, limit: pool, filter: notebookFilter(notebookId, inScope, notToc), params },
    { prefetch: { query: { sample: "random" }, limit: sampleSize, filter: notebookFilter(notebookId, inScope) }, query: dense, using: qdrant.DENSE, limit: sampleSize },
  ];
  const sparse = querySparse(lexicalQuery);
  if (sparse.indices.length) searches.push({ query: sparse, using: qdrant.SPARSE, limit: pool, filter: notebookFilter(notebookId, inScope, notToc) });
  if (codes.length) searches.push({ query: dense, using: qdrant.DENSE, limit: pool, filter: notebookFilter(notebookId, [...inScope, { key: "codes", match: { any: codes } }]), params });
  const out = await qdrant.queryBatch(searches);
  return { dense: out[0], sample: out[1].map(p => p.score), sparse: sparse.indices.length ? out[2] : [], code: codes.length ? out[sparse.indices.length ? 3 : 2] : [] };
}
// Similaridade densa de pontos específicos (candidatos que vieram só da lista lexical).
export async function denseScores(notebookId: string, dense: number[], ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const [points] = await qdrant.queryBatch([{ query: dense, using: qdrant.DENSE, limit: ids.length, filter: notebookFilter(notebookId, [{ has_id: ids }]), params: qdrant.searchParams() }]);
  return new Map(points.map(p => [String(p.id), p.score]));
}

// ---------- Reconciliação ----------
export type SyncReport = { at: string; ok: boolean; skipped?: string; collectionCreated?: boolean; deferredDeletions: number; orphanDocuments: number; orphanPoints: number; repairedDocuments: string[]; resumedDocuments: string[]; incompatibleDocuments: number; savedMessagesRequeued: number; error?: string };
let lastReport: SyncReport | null = null;
export const lastSyncReport = () => lastReport;
// Há trabalho pendente que a reconciliação resolve? (consulta barata ao SQLite, usada pela verificação periódica)
export function needsSync(): boolean {
  const failed = db.prepare("SELECT id FROM documents WHERE status='failed' AND stage='index'").all() as { id: string }[];
  return failed.some(d => !isBusy(d.id)) || !!db.prepare("SELECT 1 FROM vector_deletions LIMIT 1").get() || (!denseLoop && !!db.prepare("SELECT 1 FROM chunks WHERE indexed=2 LIMIT 1").get());
}

export async function reconcile(): Promise<SyncReport> {
  const report: SyncReport = { at: new Date().toISOString(), ok: false, deferredDeletions: 0, orphanDocuments: 0, orphanPoints: 0, repairedDocuments: [], resumedDocuments: [], incompatibleDocuments: 0, savedMessagesRequeued: 0 };
  try {
    if (!activeEmbeddingModel()) { report.skipped = "sem modelo de embeddings"; report.ok = true; return (lastReport = report); }
    // Confere a collection de novo (pode ter sido apagada com a aplicação no ar).
    ensured = null;
    let model: string;
    try { const r = await ensureCollection(false); model = r.model; report.collectionCreated = r.created; }
    catch (e) { if (e instanceof ModelMismatchError) { report.skipped = e.message; report.ok = true; return (lastReport = report); } throw e; }
    // 1) Exclusões que falharam antes.
    for (const d of db.prepare("SELECT id,kind,ref FROM vector_deletions ORDER BY id").all() as { id: number; kind: "document" | "notebook" | "point"; ref: string }[]) {
      if (d.kind === "point") await qdrant.deleteIds([d.ref]);
      else await qdrant.deleteByFilter({ must: [{ key: d.kind === "document" ? "document_id" : "notebook_id", match: { value: d.ref } }] });
      db.prepare("DELETE FROM vector_deletions WHERE id=?").run(d.id);
      report.deferredDeletions++;
    }
    // 2) Documentos: contagem de pontos por documento no Qdrant (facet exato) × trechos no SQLite.
    const docs = db.prepare("SELECT d.id,d.status,d.stage,d.embedding_model,(SELECT count(*) FROM chunks c WHERE c.document_id=d.id) AS n FROM documents d").all() as { id: string; status: string; stage: string; embedding_model: string | null; n: number }[];
    const byId = new Map(docs.map(d => [d.id, d]));
    const hits = await qdrant.facet("document_id", { must: [{ key: "source_type", match: { value: "document" } }] }, docs.length + 10_000);
    const inQdrant = new Map(hits.map(h => [String(h.value), h.count]));
    for (const [docId, n] of inQdrant) {
      if (byId.has(docId) && byId.get(docId)!.n) continue;
      await qdrant.deleteByFilter({ must: [{ key: "document_id", match: { value: docId } }] });
      report.orphanDocuments++; report.orphanPoints += n;
    }
    for (const d of docs) {
      if (isBusy(d.id)) continue;
      if (d.status === "processed" && d.embedding_model && d.embedding_model !== model) { report.incompatibleDocuments++; continue; }
      // Indexação interrompida (container reiniciado) ou que falhou com o Ollama/Qdrant fora: os trechos já estão no SQLite.
      const resume = (d.status === "processing" || d.status === "failed") && d.stage === "index" && d.n > 0;
      const diverged = d.status === "processed" && (inQdrant.get(d.id) ?? 0) !== d.n;
      if (!resume && !diverged) continue;
      if (diverged) db.prepare("UPDATE chunks SET indexed=0 WHERE document_id=?").run(d.id);
      (diverged ? report.repairedDocuments : report.resumedDocuments).push(d.id);
      enqueue(d.id, () => indexDocument(d.id), true).catch(e => console.warn(`[Sync] documento ${d.id}: ${e instanceof Error ? e.message : String(e)}`));
    }
    // 3) Mensagens salvas: pontos sem linha no SQLite saem; linhas marcadas como indexadas sem ponto voltam a pendentes.
    const saved = new Map((db.prepare("SELECT id,notebook_id,indexed FROM saved_messages").all() as { id: string; notebook_id: string; indexed: number }[]).map(s => [s.id, s]));
    const seen = new Set<string>();
    let offset: string | null = null;
    do {
      const page = await qdrant.scroll({ must: [{ key: "source_type", match: { value: "saved_message" } }] }, 1_000, offset);
      for (const p of page.points) seen.add(String(p.id));
      offset = page.next_page_offset;
    } while (offset);
    const orphanSaved = [...seen].filter(id => !saved.has(id));
    if (orphanSaved.length) { await qdrant.deleteIds(orphanSaved); report.orphanPoints += orphanSaved.length; }
    for (const s of saved.values()) if (s.indexed && !seen.has(s.id)) { db.prepare("UPDATE saved_messages SET indexed=0 WHERE id=?").run(s.id); report.savedMessagesRequeued++; }
    // 4) Vetores BM25 de uma versão anterior da tokenização: regravados (só o esparso).
    const resparsed = await refreshSparse();
    if (resparsed) console.info(`[Sync] índice BM25 atualizado para a versão ${SPARSE_VERSION}: ${resparsed} ponto(s).`);
    // 5) Vetores densos que ficaram pendentes (reinício, Ollama fora): o worker retoma em segundo plano.
    kickDense();
    report.ok = true;
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
  }
  return (lastReport = report);
}
