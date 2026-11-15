// One page (leitura completa por janela deslizante, consolidação, cache retomável, cancelamento) e menções "@documento" do chat.
// Sem Ollama nem Qdrant: um servidor HTTP local faz o papel do Ollama e responde conforme o tipo de etapa (pelo prompt de sistema).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-onepage-"));
process.env.SQLITE_PATH = path.join(tmp, "test.sqlite");
process.env.APP_DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, "uploads");
const { db } = await import("../src/database.js");
const { createProvider, setActive } = await import("../src/ai.js");
const { documentMentions } = await import("../src/documents.js");
const { cancelOnePage, onePageFile, onePageJob, startOnePage } = await import("../src/onepage.js");
const { cachedSummary } = await import("../src/summaries.js");

// ---------- Ollama falso ----------
type Call = { kind: string; user: string };
const calls: Call[] = [];
let delayMs = 0, longNotes = false;
const kindOf = (system: string) => /lendo um documento longo/.test(system) ? "read" : /condensa notas/.test(system) ? "condense" : /seção de um relatório/.test(system) ? "digest" : /abertura de um relatório/.test(system) ? "overview" : /temas que atravessam/.test(system) ? "themes" : /dados concretos/.test(system) ? "facts" : /glossário/.test(system) ? "terms" : "other";
const reply = (c: Call) => c.kind === "read" && longNotes ? Array.from({ length: 12 }, (_, i) => `- Fato ${i} da parte com bastante detalhe sobre o procedimento, os responsáveis e os prazos envolvidos no processo.`).join("\n").repeat(2)
  : c.kind === "read" ? `- Nota ${calls.filter(x => x.kind === "read").length}: fato concreto da parte.\n- Outro fato com o código ABC-${calls.length}.`
  : c.kind === "condense" ? "- Notas condensadas." : c.kind === "digest" ? "O documento trata do processo <script>alert(1)</script>.\n### Pontos principais\n- Ponto central um\n- Ponto central dois\n### Detalhes importantes\n- Prazo de 30 dias"
  : c.kind === "themes" ? "### Tema A\nExplicação do tema.\nDocumentos: Manual.md" : c.kind === "terms" ? "- **SLA**: acordo de nível de serviço" : "Parágrafo de texto geral.";
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", d => body += d).on("end", async () => {
    if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "fake:3b" }] }));
    if (req.url !== "/api/chat") { res.statusCode = 404; return res.end("{}"); }
    const msgs = JSON.parse(body).messages as { role: string; content: string }[];
    const call = { kind: kindOf(msgs[0].content), user: msgs[1].content };
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    calls.push(call);
    res.write(JSON.stringify({ message: { content: reply(call) }, done: false }) + "\n");
    res.end(JSON.stringify({ message: { content: "" }, done: true }) + "\n");
  });
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
setActive({ chat: createProvider({ name: "Falso", kind: "ollama", baseUrl: `http://127.0.0.1:${port}`, chatModel: "fake:3b" }).id });
after(() => { server.closeAllConnections(); server.close(); });

// ---------- Dados ----------
db.prepare("INSERT INTO notebooks(id,name) VALUES('nb','Operações')").run();
const addDoc = (id: string, name: string, chunks: { content: string; section?: string }[], status = "processed") => {
  db.prepare("INSERT INTO documents(id,notebook_id,name,type,status) VALUES(?,?,?,'md',?)").run(id, "nb", name, status);
  chunks.forEach((c, i) => db.prepare("INSERT INTO chunks(id,document_id,notebook_id,chunk_index,content,search_text,section) VALUES(?,?,?,?,?,?,?)").run(`${id}-${i}`, id, "nb", i, c.content, c.content, c.section ?? null));
};
// Documento longo (~27 mil caracteres: várias janelas de 9 mil para um modelo de 3B) e dois curtos, um deles cópia do outro.
const para = (i: number) => `Parágrafo ${i} do manual de operação. O equipamento deve ser inspecionado a cada turno e os registros guardados por 90 dias. `.repeat(6);
addDoc("long", "Manual.md", Array.from({ length: 40 }, (_, i) => ({ content: `[Seção: # Capítulo ${Math.floor(i / 10) + 1}]\n${para(i)}`, section: `# Capítulo ${Math.floor(i / 10) + 1}` })));
addDoc("short", "Política de férias.docx", [{ content: "A política de férias garante 30 dias por ano, em até três períodos." }]);
addDoc("copy", "Política de férias (1).docx", [{ content: "A política de férias garante 30 dias por ano, em até três períodos." }]);
addDoc("pending", "Rascunho.md", [], "processing");

const finished = async () => { for (let i = 0; i < 400 && onePageJob("nb")?.status === "running"; i++) await new Promise(r => setTimeout(r, 25)); return onePageJob("nb")!; };

test("menções @documento: foco pelo nome inteiro (com espaços, sem caixa), o mais longo primeiro e fora do texto da busca", () => {
  const m = documentMentions("nb", "@política de férias.docx quantos dias tenho?");
  assert.deepEqual(m.ids, ["short"]);
  assert.equal(m.text, "quantos dias tenho?");
  // "@Política de férias (1).docx" é mais longo e não pode ser confundido com a menção ao outro documento.
  assert.deepEqual(documentMentions("nb", "compare @Política de férias (1).docx e @Manual.md, por favor").ids.sort(), ["copy", "long"]);
  assert.equal(documentMentions("nb", "Pergunta a @Manual.md.").text, "Pergunta a .");
  // Só a menção: pedido de resumo do documento. Sem documento conhecido ou com e-mail no texto, nada muda.
  assert.equal(documentMentions("nb", "@Manual.md").text, "Resuma o documento.");
  assert.deepEqual(documentMentions("nb", "fale com joao@Manual.md.com e @Rascunho.md"), { text: "fale com joao@Manual.md.com e @Rascunho.md", ids: [] });
  assert.deepEqual(documentMentions("nb", "sem menção"), { text: "sem menção", ids: [] });
});

test("One page: lê cada documento inteiro por janela deslizante, consolida e gera o documento estruturado", async () => {
  calls.length = 0;
  const job = startOnePage("nb");
  assert.equal(job.docsTotal, 2, "a cópia idêntica e o documento não processado ficam de fora");
  const done = await finished();
  assert.equal(done.status, "done", done.error);
  assert.equal(done.done, done.total);
  const reads = calls.filter(c => c.kind === "read");
  assert.ok(reads.length >= 4, `o manual inteiro é lido em várias partes (${reads.length})`);
  assert.ok(reads.some(c => c.user.includes("Manual.md (parte 3 de")), "o documento é lido até o fim, não amostrado");
  // Janela deslizante: a parte seguinte recebe as notas das anteriores como memória da leitura.
  assert.match(reads[0].user, /\(início do documento\)/);
  assert.match(reads[1].user, /<notas_anteriores>\n- Nota 1:/);
  assert.ok(!reads[0].user.includes("[Seção:"), "o prefixo de seção vira linha de seção");
  assert.match(reads[0].user, /§ Capítulo 1/);
  assert.deepEqual(["overview", "themes", "facts", "terms"].map(k => calls.filter(c => c.kind === k).length), [1, 1, 1, 1]);
  const html = fs.readFileSync(onePageFile("nb"), "utf8");
  for (const id of ["visao-geral", "temas", "documentos", "dados", "termos"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes("Manual.md") && html.includes("Política de férias.docx") && !html.includes("(1).docx"));
  assert.ok(!html.includes("<script>alert") && html.includes("&lt;script&gt;"), "nada do modelo entra como HTML");
  assert.match(html, /<strong>SLA<\/strong>/);
  // A seção de cada documento vira o resumo guardado usado pelo modo resumo do chat.
  assert.equal(cachedSummary("long")?.bullets[0], "Ponto central um");
});

test("One page: gerar de novo reaproveita a leitura guardada; cancelar guarda o progresso e a próxima geração continua", async () => {
  calls.length = 0;
  startOnePage("nb");
  assert.equal((await finished()).status, "done");
  assert.equal(calls.filter(c => c.kind === "read" || c.kind === "digest").length, 0, "documentos sem mudança não são lidos de novo");

  // Conteúdo do manual mudou: a leitura recomeça; cancela no meio dela.
  db.prepare("UPDATE chunks SET content=content||' Revisão 2.' WHERE document_id='long' AND chunk_index=0").run();
  calls.length = 0; delayMs = 40;
  startOnePage("nb");
  // Leitura nova em andamento: a seção pronta (digest) da versão anterior foi descartada.
  const savedNotes = () => { const r = db.prepare("SELECT notes,digest FROM onepage_digests WHERE document_id='long'").get() as { notes: string; digest: string | null }; return r.digest ? [] : JSON.parse(r.notes) as string[]; };
  for (let i = 0; i < 400 && savedNotes().length < 2; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(cancelOnePage("nb"));
  const cancelled = await finished();
  assert.equal(cancelled.status, "cancelled");
  const saved = savedNotes();
  assert.ok(saved.length >= 2 && saved.length < 4, `as partes já lidas ficam guardadas (${saved.length})`);

  calls.length = 0; delayMs = 0;
  startOnePage("nb");
  assert.equal((await finished()).status, "done");
  const first = calls.find(c => c.kind === "read");
  assert.ok(first && first.user.includes(`(parte ${saved.length + 1} de`), "continua da primeira parte não lida");
});

test("One page: notas maiores que o contexto são consolidadas em camadas antes da seção do documento", async () => {
  db.prepare("UPDATE chunks SET content=content||' Revisão 3.' WHERE document_id='long' AND chunk_index=0").run();
  calls.length = 0; longNotes = true;
  startOnePage("nb");
  const done = await finished();
  longNotes = false;
  assert.equal(done.status, "done", done.error);
  assert.equal(done.done, done.total, "as etapas de consolidação entram no total");
  assert.ok(calls.some(c => c.kind === "condense"));
  const digest = calls.find(c => c.kind === "digest")!;
  assert.ok(digest.user.length < 9_500, "a seção é escrita a partir das notas consolidadas, que cabem no contexto");
});
