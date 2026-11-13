// Memória da conversa (sem LLM): resolução de perguntas de acompanhamento e histórico que vai ao prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-memory-"));
process.env.DATABASE_PATH = path.join(tmp, "test.sqlite");
process.env.UPLOAD_DIR = path.join(tmp, "uploads");
const { resolveFollowUp, usefulHistory, trimHistory } = await import("../src/rag.js");

type M = { role: string; content: string };
const turn = (...pairs: [string, string][]): M[] => pairs.flatMap(([q, a]) => [{ role: "user", content: q }, { role: "assistant", content: a }]);
const arara = turn(["Qual é o orçamento do PRJ-ARARA?", "O orçamento do PRJ-ARARA é R$ 680.000."]);

test("sem histórico ou pergunta autônoma: nada muda", () => {
  assert.equal(resolveFollowUp("E quem é o patrocinador dele?", []).mode, "none");
  for (const q of ["Qual porta TCP o gateway industrial usa para OPC UA?", "Qual o projeto mais caro?", "Quais projetos estão em execução?", "O que é backup incremental?", "Resuma o documento", "Qual é o patrocinador do PRJ-ESTUFA?"]) {
    const r = resolveFollowUp(q, arara);
    assert.equal(r.mode, "none", q);
    assert.equal(r.query, q);
  }
});

test("pronome herda o código da pergunta anterior, sem LLM", () => {
  const r = resolveFollowUp("E quem é o patrocinador dele?", arara);
  assert.equal(r.mode, "codes");
  assert.equal(r.query, "E quem é o patrocinador dele (PRJ-ARARA)?");
  assert.equal(r.intentText, r.query);
  assert.equal(resolveFollowUp("Qual é o risco principal desse projeto?", arara).mode, "codes");
});

test("o assunto atravessa vários acompanhamentos", () => {
  const h = [...arara, ...turn(["E quem é o patrocinador dele?", "É a Lúcia Ferraz."])];
  const r = resolveFollowUp("E qual o status dele?", h);
  assert.equal(r.mode, "codes");
  assert.match(r.query, /PRJ-ARARA/);
});

test("referente vindo da resposta (1–2 códigos); listas longas não definem referente", () => {
  const h = turn(["Qual projeto tem o maior orçamento?", "O maior orçamento é do PRJ-ORION: R$ 1.480.000."]);
  assert.equal(resolveFollowUp("Quem é o patrocinador dele?", h).query, "Quem é o patrocinador dele (PRJ-ORION)?");
  const list = turn(["Liste os projetos em execução", "PRJ-ORION, PRJ-ARARA, PRJ-LUME, PRJ-CEDRO e PRJ-TRILHA."]);
  assert.equal(resolveFollowUp("E quem é o patrocinador dele?", list).mode, "model");
});

test("pergunta e resposta com códigos diferentes: ambíguo, vai para o LLM com plano B", () => {
  const h = turn(["Qual projeto depende do PRJ-CEDRO?", "O PRJ-ORION depende do PRJ-CEDRO."]);
  const r = resolveFollowUp("Qual o orçamento dele?", h);
  assert.equal(r.mode, "model");
  assert.match(r.query, /PRJ-CEDRO/);
});

test("consulta de conjunto não herda código (não vira busca por registro)", () => {
  const r = resolveFollowUp("E quantos estão em execução?", arara);
  assert.equal(r.mode, "model");
  assert.doesNotMatch(r.intentText, /PRJ-ARARA/);
});

test("sem código: plano B com o assunto anterior, mas a intenção estruturada fica só com a pergunta", () => {
  const h = turn(["Qual o MTTR médio dos incidentes P1?", "O MTTR médio dos incidentes P1 é de 95 minutos."]);
  const r = resolveFollowUp("E como ele é calculado?", h);
  assert.equal(r.mode, "model");
  assert.match(r.query, /sobre: Qual o MTTR/);
  assert.equal(r.intentText, "E como ele é calculado?");
});

test("pedido de elaboração reaproveita o assunto resolvido", () => {
  const h = [...arara, ...turn(["E quem é o patrocinador dele?", "É a Lúcia Ferraz."])];
  const r = resolveFollowUp("explique melhor", h);
  assert.equal(r.mode, "elaboration");
  assert.equal(r.query, "E quem é o patrocinador dele (PRJ-ARARA)? (explique melhor)");
});

test("pergunta curta sem pronome é ambígua: sem herança determinística", () => {
  const r = resolveFollowUp("Qual o prazo?", arara);
  assert.equal(r.mode, "model");
  assert.equal(r.query, "Qual o prazo?");
  assert.equal(resolveFollowUp("E-mail do responsável pelo APP-MES?", arara).mode, "none");
});

test("recusas saem do histórico com a pergunta que as gerou", () => {
  const h = [...turn(["Qual o código secreto?", "Não encontrei essa informação nos documentos."]), ...arara];
  assert.deepEqual(usefulHistory(h), arara);
  // A recusa não define referente.
  const r = resolveFollowUp("E dele?", turn(["Qual o prazo do PRJ-XYZ?", "Não encontrei essa informação nos documentos."]));
  assert.match(r.query, /PRJ-XYZ/);
});

test("a janela do prompt sempre começa por pergunta do usuário", () => {
  const h = [...turn(["a", "b"]), ...turn(["c", "x".repeat(900)])];
  const kept = trimHistory(h.slice(1));
  assert.equal(kept[0].role, "user");
});
