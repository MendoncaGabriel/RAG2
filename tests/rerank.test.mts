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
