// Modo de voz (sem modelos): limpeza do texto falado, normalização pt-BR e escolha do idioma da voz.
import { test } from "node:test";
import assert from "node:assert/strict";
const { speechText, normalizePt, detectLang } = await import("../src/voice.js");

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
