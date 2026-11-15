// Reranking local (sem baixar modelo): ordem final, limites por ambiente e queda para a ordem da busca quando desligado.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-rerank-"));
process.env.SQLITE_PATH = path.join(tmp, "test.sqlite");
process.env.APP_DATA_DIR = tmp;
const { rerankOrder, rerankTopN, rerankCandidates, rerankScores } = await import("../src/rerank.js");

test("ordena pela pontuação do Cross-Encoder e corta no topN", () => {
  assert.deepEqual(rerankOrder([0.1, 3.2, -1, 2.5, 0.9], [0, 0, 0, 0, 0], 4), [1, 3, 4, 0]);
  assert.deepEqual(rerankOrder([1, 2], [0, 0], 4), [1, 0]);
});

test("casamento exato de código fica na frente; empate mantém a ordem da busca", () => {
  // O trecho 2 tem o código citado na pergunta: vence o 0, que o Cross-Encoder achou mais parecido.
  assert.deepEqual(rerankOrder([5, 1, 0.5, 4], [0, 0, 1, 0], 2), [2, 0]);
  // Mais códigos da pergunta no trecho pesam mais.
  assert.deepEqual(rerankOrder([1, 1, 1], [0.5, 1, 0], 3), [1, 0, 2]);
  assert.deepEqual(rerankOrder([2, 2, 2], [0, 0, 0], 3), [0, 1, 2]);
});

test("corte de relevância sem número fixo: fica o que está perto do melhor; o melhor e os de código exato sempre", () => {
  const n = 25; // sem teto: todos os candidatos podem seguir
  // Resposta clara (melhor 9,5): só os dois trechos certos ficam (valores da calibração na base Verdanis).
  assert.deepEqual(rerankOrder([9.49, -2.36, 7.35, -3.17], [0, 0, 0, 0], n, 6), [0, 2]);
  // Só um trecho relevante: só ele segue.
  assert.deepEqual(rerankOrder([10.7, 1.6, -3], [0, 0, 0], n, 6), [0]);
  // Mais de 5 relevantes: todos seguem, do mais para o menos relevante.
  assert.deepEqual(rerankOrder([6, 5.5, 5, 4.8, 4.1, 3.9, 3.2, -4], [0, 0, 0, 0, 0, 0, 0, 0], n, 6), [0, 1, 2, 3, 4, 5, 6]);
  // Tabela (melhor 2,7, gabarito em -2,7): dentro da distância, o trecho fica.
  assert.deepEqual(rerankOrder([2.67, -2.73, -0.15, -4.89], [0, 0, 0, 0], n, 6), [0, 2, 1]);
  // Tudo negativo: o melhor sempre segue (o modelo decide se responde); código exato não é cortado.
  assert.deepEqual(rerankOrder([-9, -4.9, -12], [0, 0, 0], n, 6), [1, 0]);
  assert.deepEqual(rerankOrder([8, -5, 1], [0, 1, 0], n, 6), [1, 0]);
  // RERANK_TOP_N, quando definido, é um teto.
  assert.deepEqual(rerankOrder([5, 4, 3, 2], [0, 0, 0, 0], 2, 6), [0, 1]);
});

test("limites por ambiente", () => {
  assert.equal(rerankCandidates(), 25);
  assert.equal(rerankTopN(4), 4);
  process.env.RERANK_TOP_N = "6"; process.env.RERANK_CANDIDATES = "40";
  assert.equal(rerankTopN(4), 6);
  assert.equal(rerankCandidates(), 40);
  process.env.RERANK_TOP_N = ""; process.env.RERANK_CANDIDATES = "";
  assert.equal(rerankTopN(5), 5);
  assert.equal(rerankCandidates(), 25);
});

test("desligado (RERANK_ENABLED=false): sem pontuação, a busca usa a própria ordem", async () => {
  process.env.RERANK_ENABLED = "false";
  assert.equal(await rerankScores("qual o orçamento?", ["a", "b"]), null);
  delete process.env.RERANK_ENABLED;
  assert.equal(await rerankScores("qual o orçamento?", []), null);
});
