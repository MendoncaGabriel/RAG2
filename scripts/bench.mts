// Benchmark ponta a ponta do RAG contra o gabarito da base Verdanis, com o Ollama local.
// Uso: npx tsx scripts/bench.mts [--src ./src] [--label nova] [--out bench.json] [--only id1,id2] [--retrieval]
//                                [--distract <arquivo|pasta>] [--distract-mb 50]
// --src permite medir outra versão do código (ex.: uma cópia da versão anterior) com as mesmas perguntas.
// --retrieval mede só a recuperação (P@K, R@K, MRR, trechos nas perguntas sem resposta), sem o LLM gerar: ~1 s por pergunta.
// --variants "SPARSE_EXP=stop;SPARSE_EXP=stop,exact" roda as perguntas com cada conjunto de variáveis sobre a mesma indexação
//   (os vetores BM25 são regravados entre as variantes).
// --distract indexa no mesmo notebook outros documentos (pasta varrida recursivamente, até --distract-mb MB de arquivos) para
//   medir como a recuperação se comporta quando a base cresce; o gabarito continua sendo a base Verdanis.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const arg = (name: string, fallback = "") => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.resolve(arg("src", path.join(root, "src")));
const label = arg("label", path.basename(path.dirname(src)));
const out = arg("out", "");
const only = arg("only", "").split(",").filter(Boolean);
const retrievalOnly = process.argv.includes("--retrieval");
const distract = arg("distract", ""), distractMB = Number(arg("distract-mb", "0")) || Infinity;
const chatModel = process.env.BENCH_CHAT_MODEL || process.env.OLLAMA_LLM_MODEL || "qwen3:1.7b", embeddingModel = process.env.BENCH_EMBED_MODEL || process.env.OLLAMA_EMBEDDING_MODEL || "bge-m3";
const ollama = process.env.BENCH_OLLAMA_URL || process.env.OLLAMA_BASE_URL || "http://localhost:11434";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-bench-"));
process.env.SQLITE_PATH = path.join(tmp, "bench.sqlite");
process.env.APP_DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, "uploads");
// Reranker fora da pasta temporária: o modelo baixado serve às próximas execuções.
process.env.RERANK_DIR ||= path.join(os.tmpdir(), "rag-reranker");
// Collection própria e temporária no Qdrant (QDRANT_URL/QDRANT_API_KEY do ambiente): não toca nos dados da aplicação.
const benchCollection = `bench_${Date.now()}`;
process.env.QDRANT_COLLECTION = benchCollection;
const load = (m: string) => import(pathToFileURL(path.join(src, m)).href);
const { db } = await load("database.ts");
const ai = await load("ai.ts");
const documents = await load("documents.ts");
const rag = await load("rag.ts");

// prev: perguntas anteriores da mesma conversa, respondidas pelo próprio modelo antes da pergunta medida (memória da conversa).
type Q = { id: string; cat: string; q: string; prev?: string[]; must?: string[]; mustNot?: string[]; ordered?: string[]; gold?: string[]; abstain?: boolean };
const questions: Q[] = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/bench_questions.json"), "utf8")).filter((q: Q) => !only.length || only.includes(q.id));
const corpus = fs.readFileSync(path.join(root, "tests/fixtures/Base_RAG_Verdanis.md"), "utf8");
const norm = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const abstained = (a: string) => /n[aã]o encontrei|n[aã]o (h[aá]|consta|existe|est[aá] dispon)|n[aã]o (possui|cont[eé]m|informa)|sem informa/i.test(a);

const provider = ai.createProvider({ name: "Ollama bench", kind: "ollama", baseUrl: ollama, chatModel, embeddingModel });
ai.setActive({ chat: provider.id, embedding: provider.id });
const nb = "bench-nb", doc = "bench-doc";
db.prepare("INSERT INTO notebooks(id,name) VALUES(?,?)").run(nb, "Bench");
db.prepare("INSERT INTO documents(id,notebook_id,name,type,status) VALUES(?,?,?,?,'processing')").run(doc, nb, "Base_RAG_Verdanis.md", "md");
const tIngest = Date.now();
await documents.processDocument(doc, nb, null, "Base_RAG_Verdanis.md", corpus);
// Distratores: outros documentos no mesmo notebook (a base cresce; as perguntas e o gabarito não mudam).
let distractFiles = 0, distractBytes = 0;
if (distract) {
  const supported = /\.(pdf|docx|pptx|xlsx|xls|csv|txt|md|markdown|json|jsonl|html?|xml|ya?ml|toml|sql|log|js|ts|py|java|c|cpp|h|css|sh)$/i;
  const walk = (p: string): string[] => fs.statSync(p).isDirectory() ? fs.readdirSync(p).sort().flatMap(n => walk(path.join(p, n))) : supported.test(p) ? [p] : [];
  for (const file of walk(path.resolve(distract))) {
    const size = fs.statSync(file).size;
    if (distractBytes + size > distractMB * 1048576) continue;
    const id = `distract-${distractFiles++}`, name = path.basename(file);
    db.prepare("INSERT INTO documents(id,notebook_id,name,type,status) VALUES(?,?,?,?,'processing')").run(id, nb, name, path.extname(name).slice(1).toLowerCase());
    try { await documents.processDocument(id, nb, file, name); distractBytes += size; } catch (e) { console.warn(`[${label}] distrator ignorado (${name}): ${e instanceof Error ? e.message : e}`); }
  }
}
const lexicalMs = Date.now() - tIngest;
// Busca semântica preenchida em segundo plano (indexação BM25 primeiro): o benchmark espera terminar antes das perguntas.
await (await load("indexing.ts")).denseIdle?.();
const ingestMs = Date.now() - tIngest;
// O reranker carrega antes da 1ª pergunta (no servidor ele carrega na inicialização). Versões antigas (--src) não têm.
await rag.prepareReranker?.();
const chunks = (db.prepare("SELECT count(*) AS n, avg(length(content)) AS avg FROM chunks").get() as { n: number; avg: number });
console.log(`[${label}] ingestão: ${ingestMs} ms (pesquisável por BM25 em ${lexicalMs} ms) · ${chunks.n} trechos (média ${Math.round(chunks.avg)} chars)${distract ? ` · ${distractFiles} distratores, ${(distractBytes / 1048576).toFixed(1)} MB` : ""} · ${Math.round(chunks.n / Math.max(1, ingestMs / 1000))} trechos/s`);

async function run(q: Q) {
  const history: { role: string; content: string }[] = [];
  for (const p of q.prev || []) { const r = await rag.ask(nb, p, { history: [...history], retrievalOnly }); history.push({ role: "user", content: p }, { role: "assistant", content: r.answer }); }
  const t0 = performance.now();
  let tSources = 0, retrieved: any[] = [];
  const result = await rag.ask(nb, q.q, { history, retrievalOnly, onSources: (s: any[]) => { tSources = performance.now(); retrieved = s; } });
  const t1 = performance.now();
  const answer: string = result.answer, a = norm(answer);
  const finalSources: any[] = result.sources || [];
  const failures: string[] = [];
  if (!retrievalOnly) for (const m of q.must || []) if (!new RegExp(m, "i").test(a)) failures.push(`faltou /${m}/`);
  const forbidden = (q.mustNot || []).filter(m => new RegExp(m, "i").test(a));
  for (const m of forbidden) failures.push(`proibido /${m}/`);
  if (q.ordered && !retrievalOnly) {
    const pos = q.ordered.map(alt => { const m = a.match(new RegExp(alt, "i")); return m ? m.index! : -1; });
    if (pos.some(p => p < 0) || pos.some((p, i) => i && p < pos[i - 1])) failures.push("ordem incorreta");
  }
  const didAbstain = retrievalOnly ? !retrieved.length : abstained(answer);
  if (retrievalOnly) {
    // Só a recuperação: "correta" = achou evidência do gabarito (ou nada, nas perguntas sem resposta).
    const gold = (q.gold || []).map(norm);
    if (q.abstain ? retrieved.length > 0 : gold.length && !retrieved.some(s => gold.some(g => norm(s.excerpt || "").includes(g)))) failures.push(q.abstain ? `${retrieved.length} trecho(s) numa pergunta sem resposta` : "evidência não recuperada");
  } else if (q.abstain && !didAbstain) failures.push("deveria se abster");
  else if (!q.abstain && didAbstain) failures.push("absteve-se indevidamente");
  // Recuperação: um item recuperado é relevante se contém algum trecho de evidência do gabarito.
  const gold = (q.gold || []).map(norm);
  const rel = retrieved.map(s => gold.some(g => norm(s.excerpt || "").includes(g)));
  const k = retrieved.length;
  const precision = gold.length && k ? rel.filter(Boolean).length / k : null;
  const recall = gold.length ? gold.filter(g => retrieved.some(s => norm(s.excerpt || "").includes(g))).length / gold.length : null;
  const firstRel = rel.indexOf(true);
  const mrr = gold.length ? (firstRel >= 0 ? 1 / (firstRel + 1) : 0) : null;
  // Fidelidade (proxy): códigos e números citados na resposta que aparecem nas fontes recuperadas.
  const evidence = norm(retrieved.map(s => s.excerpt || "").join("\n"));
  const claims = [...new Set([...(answer.match(/\b[A-Z]{2,10}(?:-[A-Z0-9]+)+\b/g) || []), ...(answer.match(/\d[\d.,]*\d/g) || [])].map(norm))];
  const faithfulness = claims.length ? claims.filter(c => evidence.includes(c)).length / claims.length : null;
  const citationOk = q.abstain ? finalSources.length === 0 || didAbstain : gold.length ? finalSources.some(s => gold.some(g => norm(s.excerpt || "").includes(g))) : null;
  const hallucinated = forbidden.length > 0 || (!!q.abstain && !didAbstain);
  return {
    id: q.id, cat: q.cat, correct: failures.length === 0, failures, hallucinated, abstainCorrect: q.abstain ? didAbstain : null,
    precision, recall, mrr, faithfulness, citationOk, k, sources: finalSources.length,
    retrievalMs: Math.round((tSources || t1) - t0), generationMs: Math.round(t1 - (tSources || t1)), totalMs: Math.round(t1 - t0),
    answer: answer.slice(0, 400),
  };
}

async function runVariant(label: string) {
const results: any[] = [];
for (const q of questions) {
  const r = await run(q);
  results.push(r);
  console.log(`[${label}] ${r.correct ? "✔" : "✘"} ${q.id} ${r.totalMs}ms ${r.failures.join("; ")}`);
}
// Consultas simultâneas: três perguntas ao mesmo tempo precisam terminar sem erro e com a mesma correção.
const concurrentIds = retrievalOnly ? [] : ["simples-01", "filtro-01", "historico-01"].filter(id => questions.some(q => q.id === id));
let concurrent: any = null;
if (concurrentIds.length) {
  const t0 = performance.now();
  try {
    const rs = await Promise.all(concurrentIds.map(id => run(questions.find(q => q.id === id)!)));
    concurrent = { ok: true, correct: rs.filter(r => r.correct).length, total: rs.length, totalMs: Math.round(performance.now() - t0) };
  } catch (e) { concurrent = { ok: false, error: String(e) }; }
}
const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const pct = (x: number | null) => x == null ? "-" : `${(x * 100).toFixed(1)}%`;
const byCat: Record<string, string> = {};
for (const cat of [...new Set(results.map(r => r.cat))]) { const rs = results.filter(r => r.cat === cat); byCat[cat] = `${rs.filter(r => r.correct).length}/${rs.length}`; }
let ollamaMemory: number | null = null;
try { ollamaMemory = ((await (await fetch(`${ollama}/api/ps`)).json()).models || []).reduce((s: number, m: any) => s + (m.size || 0), 0); } catch {}
const summary = {
  label, chatModel, embeddingModel, questions: results.length, ingestMs, lexicalMs, distractFiles, distractMB: distractBytes / 1048576, chunks: chunks.n, avgChunkChars: Math.round(chunks.avg),
  accuracy: results.filter(r => r.correct).length / results.length,
  precisionAtK: avg(results.map(r => r.precision)), recallAtK: avg(results.map(r => r.recall)), mrr: avg(results.map(r => r.mrr)),
  faithfulness: avg(results.map(r => r.faithfulness)), hallucinationRate: results.filter(r => r.hallucinated).length / results.length,
  abstentionCorrect: avg(results.filter(r => r.abstainCorrect != null).map(r => r.abstainCorrect ? 1 : 0)),
  citationAccuracy: avg(results.filter(r => r.citationOk != null).map(r => r.citationOk ? 1 : 0)),
  avgRetrievalMs: Math.round(avg(results.map(r => r.retrievalMs))!), avgGenerationMs: Math.round(avg(results.map(r => r.generationMs))!), avgTotalMs: Math.round(avg(results.map(r => r.totalMs))!),
  p95TotalMs: [...results.map(r => r.totalMs)].sort((a, b) => a - b)[Math.floor(results.length * 0.95) - (results.length > 1 ? 1 : 0)],
  rssMB: Math.round(process.memoryUsage().rss / 1048576), ollamaLoadedMB: ollamaMemory ? Math.round(ollamaMemory / 1048576) : null,
  byCategory: byCat, concurrent,
};
if (retrievalOnly) console.log(`\n[${label}] RECUPERAÇÃO · evidência achada ${pct(summary.accuracy)} · P@K ${pct(summary.precisionAtK)} · R@K ${pct(summary.recallAtK)} · MRR ${summary.mrr?.toFixed(3)} · trechos/pergunta ${avg(results.map(r => r.k))?.toFixed(1)} · busca média ${summary.avgRetrievalMs}ms`);
else console.log(`\n[${label}] acerto ${pct(summary.accuracy)} · P@K ${pct(summary.precisionAtK)} · R@K ${pct(summary.recallAtK)} · MRR ${summary.mrr?.toFixed(3)} · fidelidade ${pct(summary.faithfulness)} · alucinação ${pct(summary.hallucinationRate)} · abstenção ${pct(summary.abstentionCorrect)} · citação ${pct(summary.citationAccuracy)}`);
console.log(`[${label}] tempo médio: busca ${summary.avgRetrievalMs}ms · geração ${summary.avgGenerationMs}ms · total ${summary.avgTotalMs}ms (p95 ${summary.p95TotalMs}ms) · RSS ${summary.rssMB} MB · Ollama ${summary.ollamaLoadedMB ?? "-"} MB`);
console.log(`[${label}] por categoria: ${JSON.stringify(byCat)} · simultâneas: ${JSON.stringify(concurrent)}`);
return { summary, results };
}
// Variantes (--variants "A=1 B=2;A=3"): a base é indexada uma vez; para cada variante as variáveis mudam, os vetores BM25 são
// regravados (só o esparso, sem recalcular embeddings) e as perguntas rodam de novo. Compara ajustes da busca lexical, da
// expansão etc. sem pagar a indexação a cada vez.
const sparseMod = await load("sparse.ts"), qd = await load("qdrant.ts");
async function resparse() {
  const rows = db.prepare("SELECT id,search_text FROM chunks WHERE indexed<>0").all() as { id: string; search_text: string }[];
  for (let i = 0; i < rows.length; i += 256)
    await qd.updateVectors(rows.slice(i, i + 256).map(r => ({ id: r.id, vector: { bm25: sparseMod.documentSparse(r.search_text) } })));
}
const variants = arg("variants", "") ? arg("variants", "").split(";").map(v => v.trim()) : [""];
const all: any[] = [];
for (const v of variants) {
  if (v) {
    for (const kv of v.split(/\s+/).filter(Boolean)) { const [k, ...rest] = kv.split("="); process.env[k] = rest.join("="); }
    await resparse();
    // QDRANT_QUANTIZATION / QDRANT_SPARSE_ON_DISK da variante: aplicados na collection (PATCH) e esperando o Qdrant reconstruir.
    if ((await qd.syncCollectionConfig((await qd.getCollection())!)).length)
      for (let t = Date.now(); Date.now() - t < 300_000 && (await qd.getCollection())!.status !== "green";) await new Promise(r => setTimeout(r, 500));
  }
  all.push(await runVariant(v ? `${label}[${v}]` : label));
}
if (variants.length > 1) {
  console.log(`\n[${label}] RESUMO DAS VARIANTES`);
  for (const [i, r] of all.entries()) console.log(`  ${variants[i] || "(padrão)"} · evidência ${(r.summary.accuracy * 100).toFixed(1)}% · P@K ${((r.summary.precisionAtK ?? 0) * 100).toFixed(1)}% · R@K ${((r.summary.recallAtK ?? 0) * 100).toFixed(1)}% · MRR ${r.summary.mrr?.toFixed(3)} · ${JSON.stringify(r.summary.byCategory)}`);
}
if (out) fs.writeFileSync(out, JSON.stringify(variants.length > 1 ? all.map((r, i) => ({ variant: variants[i], ...r })) : all[0], null, 2));
try { await (await load("qdrant.ts")).deleteCollection(benchCollection); } catch {}
try { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch {} // Windows: o SQLite aberto impede apagar a pasta
process.exit(0);
