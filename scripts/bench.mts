// Benchmark ponta a ponta do RAG contra o gabarito da base Verdanis, com o Ollama local.
// Uso: npx tsx scripts/bench.mts [--src ./src] [--label nova] [--out bench.json] [--only id1,id2]
// --src permite medir outra versão do código (ex.: uma cópia da versão anterior) com as mesmas perguntas.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name: string, fallback = "") => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = path.resolve(arg("src", path.join(root, "src")));
const label = arg("label", path.basename(path.dirname(src)));
const out = arg("out", "");
const only = arg("only", "").split(",").filter(Boolean);
const chatModel = process.env.BENCH_CHAT_MODEL || "qwen2.5:1.5b", embeddingModel = process.env.BENCH_EMBED_MODEL || "bge-m3";
const ollama = process.env.BENCH_OLLAMA_URL || "http://localhost:11434";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-bench-"));
process.env.DATABASE_PATH = path.join(tmp, "bench.sqlite");
process.env.UPLOAD_DIR = path.join(tmp, "uploads");
process.env.CONVERSATION_SUMMARY = "false";
const load = (m: string) => import(pathToFileURL(path.join(src, m)).href);
const { db } = await load("database.ts");
const ai = await load("ai.ts");
const documents = await load("documents.ts");
const rag = await load("rag.ts");

type Q = { id: string; cat: string; q: string; must?: string[]; mustNot?: string[]; ordered?: string[]; gold?: string[]; abstain?: boolean };
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
const ingestMs = Date.now() - tIngest;
const chunks = (db.prepare("SELECT count(*) AS n, avg(length(content)) AS avg FROM chunks").get() as { n: number; avg: number });
console.log(`[${label}] ingestão: ${ingestMs} ms · ${chunks.n} trechos (média ${Math.round(chunks.avg)} chars)`);

async function run(q: Q) {
  const t0 = performance.now();
  let tSources = 0, retrieved: any[] = [];
  const result = await rag.ask(nb, q.q, { onSources: (s: any[]) => { tSources = performance.now(); retrieved = s; } });
  const t1 = performance.now();
  const answer: string = result.answer, a = norm(answer);
  const finalSources: any[] = result.sources || [];
  const failures: string[] = [];
  for (const m of q.must || []) if (!new RegExp(m, "i").test(a)) failures.push(`faltou /${m}/`);
  const forbidden = (q.mustNot || []).filter(m => new RegExp(m, "i").test(a));
  for (const m of forbidden) failures.push(`proibido /${m}/`);
  if (q.ordered) {
    const pos = q.ordered.map(alt => { const m = a.match(new RegExp(alt, "i")); return m ? m.index! : -1; });
    if (pos.some(p => p < 0) || pos.some((p, i) => i && p < pos[i - 1])) failures.push("ordem incorreta");
  }
  const didAbstain = abstained(answer);
  if (q.abstain && !didAbstain) failures.push("deveria se abster");
  if (!q.abstain && didAbstain) failures.push("absteve-se indevidamente");
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

const results: any[] = [];
for (const q of questions) {
  const r = await run(q);
  results.push(r);
  console.log(`[${label}] ${r.correct ? "✔" : "✘"} ${q.id} ${r.totalMs}ms ${r.failures.join("; ")}`);
}
// Consultas simultâneas: três perguntas ao mesmo tempo precisam terminar sem erro e com a mesma correção.
const concurrentIds = ["simples-01", "filtro-01", "historico-01"].filter(id => questions.some(q => q.id === id));
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
  label, chatModel, embeddingModel, questions: results.length, ingestMs, chunks: chunks.n, avgChunkChars: Math.round(chunks.avg),
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
console.log(`\n[${label}] acerto ${pct(summary.accuracy)} · P@K ${pct(summary.precisionAtK)} · R@K ${pct(summary.recallAtK)} · MRR ${summary.mrr?.toFixed(3)} · fidelidade ${pct(summary.faithfulness)} · alucinação ${pct(summary.hallucinationRate)} · abstenção ${pct(summary.abstentionCorrect)} · citação ${pct(summary.citationAccuracy)}`);
console.log(`[${label}] tempo médio: busca ${summary.avgRetrievalMs}ms · geração ${summary.avgGenerationMs}ms · total ${summary.avgTotalMs}ms (p95 ${summary.p95TotalMs}ms) · RSS ${summary.rssMB} MB · Ollama ${summary.ollamaLoadedMB ?? "-"} MB`);
console.log(`[${label}] por categoria: ${JSON.stringify(byCat)} · simultâneas: ${JSON.stringify(concurrent)}`);
if (out) fs.writeFileSync(out, JSON.stringify({ summary, results }, null, 2));
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
