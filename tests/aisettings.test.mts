// Ajustes de IA guardados no SQLite (Configurações): automático (0) ou manual, validação, persistência e escolha automática de modelos.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-aisettings-"));
process.env.SQLITE_PATH = path.join(tmp, "test.sqlite");
process.env.APP_DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, "uploads");
// Variáveis antigas de IA não têm mais efeito.
process.env.CHAT_CONTEXT_TOKENS = "99999"; process.env.CHAT_MAX_TOKENS = "99999"; process.env.RETRIEVAL_TOP_K = "11";
const { getAiTuning, setAiTuning, defaultTuning } = await import("../src/aisettings.js");
const { db } = await import("../src/database.js");
const { pickModels, candidateUrls } = await import("../src/ai.js");
const { deriveProfile } = await import("../src/modelprofile.js");

test("padrão: tudo automático, e o .env não altera o perfil do modelo", () => {
  assert.deepEqual(getAiTuning(), defaultTuning());
  assert.equal(deriveProfile("qwen3:1.7b").contextTokens, 8192);
});

test("contexto manual vence o perfil, mas nunca passa do contexto nativo do modelo", () => {
  assert.equal(deriveProfile("qwen3:1.7b", undefined, 16384).contextTokens, 16384);
  assert.equal(deriveProfile("phi3:mini", { parameterSize: 3.8, contextLength: 4096 }, 32768).contextTokens, 4096);
  assert.equal(deriveProfile("qwen3:1.7b", undefined, 0).contextTokens, 8192, "0 = automático");
});

test("salvar mescla os campos enviados, persiste no SQLite e 0 volta ao automático", () => {
  setAiTuning({ contextTokens: 12000, topK: 7 });
  assert.equal(getAiTuning().contextTokens, 12000);
  setAiTuning({ maxTokens: 900 });
  assert.deepEqual({ c: getAiTuning().contextTokens, m: getAiTuning().maxTokens, k: getAiTuning().topK }, { c: 12000, m: 900, k: 7 });
  const row = db.prepare("SELECT value FROM settings WHERE key='ai_tuning'").get() as { value: string };
  assert.equal(JSON.parse(row.value).contextTokens, 12000);
  setAiTuning({ contextTokens: 0, maxTokens: 0, topK: 0 });
  assert.deepEqual(getAiTuning(), defaultTuning());
});

test("valores fora dos limites e modo de threads inválido são recusados sem alterar o salvo", () => {
  setAiTuning({ contextTokens: 8192 });
  assert.throws(() => setAiTuning({ contextTokens: 100 }), /Contexto/);
  assert.throws(() => setAiTuning({ topK: 50 }), /Trechos por pergunta/);
  assert.throws(() => setAiTuning({ maxTokens: -5 }), /inválido/);
  assert.throws(() => setAiTuning({ threadMode: "tudo" }), /threads/i);
  assert.throws(() => setAiTuning({ threadMode: "manual", threads: 0 }), /threads/i);
  assert.equal(getAiTuning().contextTokens, 8192);
  setAiTuning({ contextTokens: 0 });
});

test("escolha automática: chat de família conhecida e embeddings, sem confundir um com o outro", () => {
  const picked = pickModels(["nomic-embed-text:latest", "gemma3:4b", "bge-m3:latest", "qwen3:1.7b", "llama3.2:3b"]);
  assert.equal(picked.chat, "qwen3:1.7b");
  assert.equal(picked.embedding, "bge-m3:latest");
  assert.deepEqual(pickModels(["bge-m3"]), { chat: "", embedding: "bge-m3" });
  assert.deepEqual(pickModels([]), { chat: "", embedding: "" });
});

test("endereços candidatos: só http na porta do Ollama e nunca loopback do container", () => {
  const urls = candidateUrls();
  assert.ok(urls.includes("http://localhost:11434"));
  assert.ok(urls.every(u => /^http:\/\/[^/]+:11434$/.test(u)));
  assert.ok(!urls.some(u => /\/\/127\./.test(u)));
});

test("sem resposta nos endereços conhecidos, a detecção varre os 256 gateways /20 do WSL2 (inclui 172.29.48.1)", async () => {
  const { wslGatewayCandidates } = await import("../src/ai.js");
  const urls = wslGatewayCandidates();
  assert.equal(urls.length, 256);
  assert.equal(new Set(urls).size, 256);
  assert.ok(urls.includes("http://172.29.48.1:11434"));
  assert.ok(urls.every(u => /^http:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.1:11434$/.test(u) && Number(u.split(".")[2]) % 16 === 0));
});

test("cadastro: só Ollama (sem tipo na API), nome padrão pelo endereço e chave mantida na edição", async () => {
  const { createProvider, updateProvider, listProviders } = await import("../src/ai.js");
  const p = createProvider({ baseUrl: "http://172.29.48.1:11434/", chatModel: "qwen3:1.7b", apiKey: "segredo1234", kind: "openai" });
  assert.equal(p.name, "Ollama (172.29.48.1:11434)");
  assert.equal(p.baseUrl, "http://172.29.48.1:11434");
  assert.ok(!("kind" in p) && !("kindLabel" in p));
  assert.equal(p.keyHint, "••••1234");
  const row = db.prepare("SELECT kind FROM ai_providers WHERE id=?").get(p.id) as { kind: string };
  assert.equal(row.kind, "ollama", "mesmo pedindo outro tipo");
  const e = updateProvider(p.id, { baseUrl: p.baseUrl, chatModel: "qwen3:1.7b", embeddingModel: "bge-m3" })!;
  assert.equal(e.hasKey, true, "chave em branco na edição mantém a atual");
  assert.equal(e.name, p.name);
  assert.throws(() => createProvider({ baseUrl: "ftp://x", chatModel: "a" }), /http/);
  assert.throws(() => createProvider({ baseUrl: "http://x:1" }), /ao menos um modelo/);
  assert.equal(listProviders().providers.length, 1);
});
