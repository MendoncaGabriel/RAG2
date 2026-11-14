// Ajuste automático ao PC (sem Ollama): núcleos físicos, candidatas de threads, escolha e sobrescrita manual.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-tuning-"));
process.env.SQLITE_PATH = path.join(tmp, "test.sqlite");
process.env.APP_DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, "uploads");
const { physicalFromCpuinfo, threadCandidates, pickThreads, realGpus, tunedThreads, answerSeconds } = await import("../src/tuning.js");

test("núcleos físicos do /proc/cpuinfo ignoram SMT e somam soquetes", () => {
  const block = (cpu: number, socket: number, core: number) => `processor\t: ${cpu}\nphysical id\t: ${socket}\ncore id\t\t: ${core}\n`;
  // 4 núcleos com hyperthreading (8 lógicos)
  assert.equal(physicalFromCpuinfo([0, 1, 2, 3, 0, 1, 2, 3].map((c, i) => block(i, 0, c)).join("\n")), 4);
  // 2 soquetes × 2 núcleos
  assert.equal(physicalFromCpuinfo([block(0, 0, 0), block(1, 0, 1), block(2, 1, 0), block(3, 1, 1)].join("\n")), 4);
  assert.equal(physicalFromCpuinfo("processor : 0\nmodel name : ARM\n"), undefined);
});

test("candidatas de threads: metade, 75%, núcleos − 1 e todos", () => {
  assert.deepEqual(threadCandidates(8), [4, 6, 7, 8]);
  assert.deepEqual(threadCandidates(10), [5, 8, 9, 10]);
  assert.deepEqual(threadCandidates(4), [2, 3, 4]);
  assert.deepEqual(threadCandidates(2), [1, 2]);
  assert.deepEqual(threadCandidates(1), [1]);
});

test("escolha: menor tempo; empate técnico fica com menos threads", () => {
  const s = (threads: number, promptTps: number, evalTps: number) => ({ threads, promptTps, evalTps, seconds: answerSeconds(promptTps, evalTps) });
  // Medições reais do Ryzen 7 7735U com qwen2.5:1.5b
  assert.equal(pickThreads([s(4, 153.4, 23.6), s(6, 199, 24.3), s(7, 230.6, 26.5), s(8, 232.3, 24.8)]), 7);
  assert.equal(pickThreads([s(6, 200, 25), s(8, 202, 25.2)]), 6);
  assert.equal(pickThreads([]), undefined);
});

test("GPUs que não fazem inferência são ignoradas", () => {
  assert.deepEqual(realGpus(["Microsoft Basic Display Adapter", "AMD Radeon(TM) Graphics", "Microsoft Remote Display Adapter", ""]), ["AMD Radeon(TM) Graphics"]);
});

test("OLLAMA_NUM_THREAD sobrescreve o ajuste; sem nada, o Ollama decide", () => {
  delete process.env.OLLAMA_NUM_THREAD;
  assert.equal(tunedThreads("http://localhost:11434"), undefined);
  process.env.OLLAMA_NUM_THREAD = "5";
  assert.equal(tunedThreads("http://localhost:11434"), 5);
  delete process.env.OLLAMA_NUM_THREAD;
});
