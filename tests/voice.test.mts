// Modo de voz (sem modelos): limpeza do texto falado, normalização pt-BR e escolha do idioma da voz.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-voice-"));
process.env.DATABASE_PATH = path.join(tmp, "test.sqlite");
process.env.UPLOAD_DIR = path.join(tmp, "uploads");
const { speechText, normalizePt, detectLang, fixCodes } = await import("../src/voice.js");

test("transcrição: códigos do notebook ditos em voz alta voltam ao formato exato", () => {
  const codes = ["APP-MES", "SRV-MAO", "FOR-002", "GW-OT", "APP-BI", "PRJ-ARARA"];
  assert.equal(fixCodes("Quem é o responsável pelo app mês?", codes), "Quem é o responsável pelo APP-MES?");
  assert.equal(fixCodes("Qual o status do servidor SRV Mau?", codes), "Qual o status do servidor SRV-MAO?");
  assert.equal(fixCodes("Me fale do formulário for002.", codes), "Me fale do formulário FOR-002.");
  assert.equal(fixCodes("Quem é o responsável pelo Apmes?", codes), "Quem é o responsável pelo APP-MES?");
  assert.equal(fixCodes("o apmes e o aplicativo", codes), "o apmes e o aplicativo"); // minúscula: pode ser palavra comum
  assert.equal(fixCodes("E o GW OT e o app BI, e o PRJ Arara?", codes), "E o GW-OT e o APP-BI, e o PRJ-ARARA?");
  // Frases comuns não podem ser alteradas.
  assert.equal(fixCodes("O app de mesa está no servidor de marketing.", codes), "O app de mesa está no servidor de marketing.");
  assert.equal(fixCodes("Para mim o formulário foi aprovado.", codes), "Para mim o formulário foi aprovado.");
  assert.equal(fixCodes("Qualquer coisa", []), "Qualquer coisa");
});

test("texto falado: remove markdown, tabelas, fontes, links e emojis", () => {
  assert.equal(speechText("1. **Primeiro** item [Fonte 2]"), "1, Primeiro item");
  assert.equal(speechText("| Projeto | **Orçamento** |"), "Projeto, Orçamento");
  assert.equal(speechText("|---|:---:|"), "");
  assert.equal(speechText("## Resumo\n- veja [o site](https://x.com) agora 🚀"), "Resumo veja o site agora");
  assert.equal(speechText("use *ênfase* e `codigo_fonte`"), "use ênfase e codigo_fonte");
});

test("normalização pt-BR: moeda, datas, horas, porcentagem e códigos", () => {
  assert.equal(normalizePt("R$ 1.250.000,50"), "1250000 reais, e 50 centavos");
  assert.equal(normalizePt("R$ 680 mil e R$ 1,5 milhão"), "680 mil reais e 1,5 milhão de reais");
  assert.equal(normalizePt("US$ 10"), "10 dólares");
  assert.equal(normalizePt("em 01/03/2024 e 2024-12-25"), "em 1 de março de 2024 e 25 de dezembro de 2024");
  assert.equal(normalizePt("às 14h30 ou 1h"), "às 14 horas e 30 ou 1 hora");
  assert.equal(normalizePt("subiu 15% para 2.350 unidades"), "subiu 15 por cento para 2350 unidades");
  assert.equal(normalizePt("o PRJ-ARARA, nº 42, de 10-20 km/h"), "o PRJ ARARA, número 42, de 10 a 20 quilômetros por hora");
  assert.equal(normalizePt("Versão 3,5 do app"), "Versão 3,5 do app");
});

test("idioma da voz: inglês só com sinal claro", () => {
  assert.equal(detectLang("Good evening, sir. The budget is 680 thousand dollars and it was approved."), "en");
  assert.equal(detectLang("O orçamento do projeto é de 680 mil reais."), "pt");
  assert.equal(detectLang("OK."), "pt");
});
