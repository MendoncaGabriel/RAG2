// Roteamento do modo conversa (chat com "Conversa" e voz): conversa direta não busca nos documentos; consulta busca.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-smalltalk-"));
process.env.SQLITE_PATH = path.join(tmp, "test.sqlite");
process.env.APP_DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, "uploads");
const { conversationRoute, withoutSmallTalk } = await import("../src/smalltalk.js");
const { buildDirectPrompt, spokenRule, resolveFollowUp } = await import("../src/rag.js");

const kind = (m: string, h: { role: string; content: string }[] = []) => conversationRoute(m, h).kind;

test("cumprimentos, cortesias, reações e perguntas sobre a IA: conversa direta, sem RAG", () => {
  for (const m of ["oi", "Oi!", "Olá, tudo bem?", "Oi, tudo bem? Como é que vai?", "Bom dia!", "Bom dia! Quem é você?", "boa tarde, tudo certo?", "E aí, beleza?",
    "Olá, bom dia, como você está?", "tudo bem e você?", "Estou bem, obrigado!", "obrigado pela explicação", "Valeu, até mais!", "tchau",
    "ok", "entendi", "hum, interessante", "nossa, que legal", "kkkk", "faz sentido", "Quem é você?", "Qual é o seu nome?",
    "o que você pode fazer?", "Você está me ouvindo?", "oi Bento, tudo joia?", "desculpa", "não, obrigado", "sim"])
    assert.equal(kind(m), "direct", m);
});

test("consultas ao assunto (inclusive misturadas com cumprimento): RAG", () => {
  for (const m of ["Qual é o orçamento do PRJ-ARARA?", "oi, bom dia! qual o orçamento do PRJ-ARARA?", "Olá, tudo bem? Quero saber sobre o projeto Arara",
    "Como funciona o backup incremental?", "o que é o Hefesto?", "Como está o andamento do projeto Hefesto?", "Me explica a política de retenção de logs",
    "Quais projetos estão em execução?", "Resuma os documentos", "obrigado! e qual é o prazo do contrato de manutenção?", "tudo bem com o servidor de arquivos?"])
    assert.equal(kind(m), "rag", m);
});

test("com assunto, mesmo curto ou fora dos documentos: vai à busca estrita (sem trecho achado, a IA conversa sem fontes)", () => {
  for (const m of ["Hefesto", "backup incremental", "estou cansado hoje", "Que horas são?", "Me conta uma piada"]) assert.equal(kind(m), "rag", m);
  for (const m of ["Que bom, fico feliz", "Muito obrigado pela ajuda, foi ótimo", "Oi, tudo bem? Como é que vai?", "Opa, e aí, como você tem passado?"]) assert.equal(kind(m), "direct", m);
});

test("'sim' depois de a IA oferecer aprofundar continua o assunto; sem oferta, é conversa", () => {
  const offer = [{ role: "user", content: "O que é o Hefesto?" }, { role: "assistant", content: "O Hefesto é o sistema de manutenção. Quer que eu explique como ele funciona?" }];
  for (const m of ["sim", "Pode sim!", "quero", "claro, por favor"]) assert.equal(kind(m, offer), "continue", m);
  assert.equal(kind("não", offer), "direct");
  assert.equal(kind("sim", [{ role: "user", content: "oi" }, { role: "assistant", content: "Olá! Tudo bem." }]), "direct");
});

test("conversa direta não vira assunto da busca", () => {
  const h = [
    { role: "user", content: "Qual é o orçamento do PRJ-ARARA?" }, { role: "assistant", content: "O orçamento do PRJ-ARARA é R$ 680.000." },
    { role: "user", content: "valeu!" }, { role: "assistant", content: "De nada! Posso ajudar em mais alguma coisa?" },
  ];
  assert.deepEqual(withoutSmallTalk(h).map(m => m.content), [h[0].content, h[1].content]);
  // Depois do "valeu", "e o patrocinador dele?" ainda herda o PRJ-ARARA.
  assert.match(resolveFollowUp("E quem é o patrocinador dele?", withoutSmallTalk(h)).query, /PRJ-ARARA/);
});

test("prompt da conversa direta: breve, sabe do que trata o notebook e não inventa conteúdo", () => {
  const p = buildDirectPrompt("Manutenção", ["Manual Hefesto.pdf", "Contratos.xlsx"]);
  assert.match(p, /Manual Hefesto\.pdf; Contratos\.xlsx/); assert.match(p, /"Manutenção"/);
  assert.match(p, /Nunca invente/); assert.match(p, /breve/);
  assert.doesNotMatch(buildDirectPrompt("", []), /documentos: /);
  // Busca sem trecho: conversa normalmente e diz que não encontrou se pediram algo dos documentos.
  const searched = buildDirectPrompt("Manutenção", [], true);
  assert.match(searched, /não encontrou isso neles/); assert.doesNotMatch(searched, /Esta mensagem é conversa/);
  // Modo de voz: pede texto falável; o chat escrito não recebe a regra.
  assert.match(buildDirectPrompt("Manutenção", [], false, true), /lida em voz alta/); assert.doesNotMatch(p, /voz alta/);
});

test("regra do modo voz: texto corrido, sem jargão e em português; versão curta para modelos pequenos", () => {
  const full = spokenRule(false), short = spokenRule(true);
  for (const r of [full, short]) { assert.match(r, /voz alta/); assert.match(r, /sem listas|nada de listas/); assert.match(r, /português/); }
  assert.match(full, /download/); assert.ok(short.length < full.length / 2);
});
