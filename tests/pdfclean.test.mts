// Testes determinísticos da limpeza de PDF (cabeçalho/rodapé, sumário, títulos numerados) e da detecção de sumário na busca.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-test-"));
process.env.DATABASE_PATH = path.join(tmp, "test.sqlite");
process.env.UPLOAD_DIR = path.join(tmp, "uploads");
const { cleanPdfPages, chunkStructured, isTocChunk } = await import("../src/chunking.js");
const { embeddingInput } = await import("../src/documents.js");

const header = (n: number) => `Initial release: Ana Souza\nLast saved by: Ana Souza\nTemplate version: 1.0Page:${n} of 5\nLast modified on: 11 June 2026`;
const body = (n: number) => Array.from({ length: n }, (_, i) => `Body line ${i} with ordinary content.`).join("\n");
const pages = [
  `${header(1)}\nTROUBLESHOOTING MANUAL\nHEFESTO`,
  `${header(2)}\nSUMÁRIO\n1. Introdução........................................2\n2.1 Forno Offline ou Sem Envio de Dados.........3`,
  `${header(3)}\n1. INTRODUCTION AND INITIAL DIAGNOSIS\nTroubleshooting is a systematic approach.\n${body(3)}\nResolution:\n1. Clone the repository with git clone.\n${body(4)}\n2.Run npm install.`,
  `${header(4)}\n2.1 OVEN OFFLINE OR NOT SENDING DATA\nOvens transmit data via MQTT.\n${body(3)}\nResolution:\nRestart the Publisher.\n${body(4)}\n# Frontend ----------\nAPI_URL=http://x`,
  // Página curta: "Resolution:" cai na borda, mas aparece no miolo das outras páginas e fica.
  `${header(5)}\n5.2 Oven Monitoring\nActivity Status: Shows whether the oven is offline.\nResolution:\nCheck the limits.\nCONFIDENTIAL AND PROPRIETARY\n5`,
];

test("cabeçalho e rodapé repetidos nas bordas das páginas saem; conteúdo repetido no corpo fica", () => {
  const text = cleanPdfPages(pages);
  assert.doesNotMatch(text, /Initial release|Last saved by|Template version|Last modified on/);
  assert.doesNotMatch(text, /^5$/m, "número de página solto sai");
  assert.equal(text.match(/^Resolution:$/gm)?.length, 3, "\"Resolution:\" é conteúdo, não cabeçalho");
  assert.match(text, /Troubleshooting is a systematic approach/);
});

test("linhas de sumário com pontilhado saem", () => {
  const text = cleanPdfPages(pages);
  assert.doesNotMatch(text, /\.{5,}/);
  assert.doesNotMatch(text, /Forno Offline/);
});

test("títulos numerados viram seções; passos numerados e comentários com # não", () => {
  const text = cleanPdfPages(pages);
  assert.match(text, /^# 1 INTRODUCTION AND INITIAL DIAGNOSIS$/m);
  assert.match(text, /^## 2\.1 OVEN OFFLINE OR NOT SENDING DATA$/m);
  assert.match(text, /^## 5\.2 Oven Monitoring$/m);
  assert.match(text, /^1\. Clone the repository with git clone\.$/m);
  const chunks = chunkStructured(text);
  assert.ok(chunks.some(c => c.section.endsWith("2.1 OVEN OFFLINE OR NOT SENDING DATA") && /Restart the Publisher/.test(c.content)));
  assert.ok(chunks.some(c => c.section.endsWith("5.2 Oven Monitoring") && /Activity Status/.test(c.content)));
  assert.ok(!chunks.some(c => /Frontend -{5}/.test(c.section)), "comentário de .env não vira seção");
});

test("PDF com menos de 3 páginas não perde linhas repetidas", () => {
  const two = [`Relatório\nLinha A`, `Relatório\nLinha B`];
  assert.match(cleanPdfPages(two), /Relatório[\s\S]*Relatório/);
});

test("trecho de sumário é detectado; trecho comum não", () => {
  assert.ok(isTocChunk("7.1 Erro: \"Porta 3000\"..........7\n7.2 Erro: \"Backend\"..........8\n7.3 Erro: \"Banco\"..........8"));
  assert.ok(!isTocChunk("[Seção: 3 Problemas]\nO backend usa a porta 3000. Verifique com pm2 list.\nReinicie o serviço."));
  assert.ok(!isTocChunk("Aguarde... carregando.\nTexto normal."));
});

test("texto do embedding leva o nome do documento sem extensão", () => {
  assert.equal(embeddingInput("Hefesto - Technical Manual.pdf", "Conteúdo"), "Documento: Hefesto - Technical Manual\nConteúdo");
  assert.equal(embeddingInput("Base_RAG_Verdanis.md", "X"), "Documento: Base RAG Verdanis\nX");
});
