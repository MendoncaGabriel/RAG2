// Palavra de ativação do modo de voz (public/wake.js): chamados válidos, falsos positivos e remoção do chamado da pergunta.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const sandbox: any = {};
vm.runInNewContext(fs.readFileSync(new URL("../public/wake.js", import.meta.url), "utf8"), sandbox);
const { match, stripCall } = sandbox.__bentoWake as { match: (t: string) => { rest: string; pre: boolean; comma: boolean } | null; stripCall: (t: string) => string };

test("chamados válidos", () => {
  for (const t of ["Bento", "bento.", "Oi Bento", "oi, Bento!", "Ok Bento", "OK, Bento.", "okbento", "O K Bento", "Ei Bento", "Hey Bento", "E aí, Bento?", "Olá Bento", "Ben to", "Bendo"])
    assert.ok(match(t), t);
  assert.equal(match("Ok Bento")?.rest, "");
});

test("enganos do reconhecimento com o 'oi' (medidos): chamam, mas não viram remoção na pergunta", () => {
  for (const t of ["Fui Bento, quanto custa o projeto?", "O Ibento, quanto custa?", "8 Bento, quanto custa o projeto?", "Okay, Bento, explain it again."]) assert.ok(match(t), t);
  assert.equal(match("Okay, Bento, explain it again.")?.rest, "explain it again.");
  assert.equal(stripCall("O Bento Gonçalves tem quantos habitantes?"), "O Bento Gonçalves tem quantos habitantes?");
  assert.equal(stripCall("Fui Bento, quanto custa?"), "quanto custa?"); // vírgula depois do nome
});

test("pergunta junto do chamado: devolve o resto com a pontuação original", () => {
  assert.equal(match("Ok Bento, me explica melhor o item 3.")?.rest, "me explica melhor o item 3.");
  assert.equal(match("Oi Bento espera, quanto custa?")?.rest, "espera, quanto custa?");
  assert.equal(match("Bento, o que é CAPEX?")?.comma, true);
});

test("não é chamado: conversa ao redor e o nome longe do começo", () => {
  for (const t of ["", "   ", "o vento está forte", "quem é o Bento?", "eu falei com o bento ontem", "a obra em Bento Gonçalves", "mento", "vento", "temos bentos"])
    assert.equal(match(t), null, t);
});

test("stripCall só remove chamado claro", () => {
  assert.equal(stripCall("Ok Bento, quanto custa o projeto?"), "quanto custa o projeto?");
  assert.equal(stripCall("Bento, quanto custa?"), "quanto custa?");
  assert.equal(stripCall("Oi Bento"), "");
  assert.equal(stripCall("Bento"), "");
  assert.equal(stripCall("Bento Gonçalves tem quantos habitantes?"), "Bento Gonçalves tem quantos habitantes?");
  assert.equal(stripCall("Quanto custa o projeto?"), "Quanto custa o projeto?");
});
