// Modo de voz (sem modelos): limpeza do texto falado, normalização pt-BR e escolha do idioma da voz.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rag-voice-"));
process.env.SQLITE_PATH = path.join(tmp, "test.sqlite");
process.env.APP_DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, "uploads");
const { speechText, normalizePt, pronouncePt, detectLang, fixCodes, fixTerms, extractTerms } = await import("../src/voice.js");

test("falas revisadas: áudio e texto corrigido viram par .wav + .txt em voice/samples", async () => {
  const express = (await import("express")).default, { voiceRouter, voiceDir } = await import("../src/voice.js");
  const app = express(); app.use("/api/voice", voiceRouter());
  const server = app.listen(0), port = (server.address() as { port: number }).port;
  try {
    const pcm = new Int16Array(16000).map((_, i) => Math.round(Math.sin(i / 8) * 8000));
    const post = (text: string) => fetch(`http://127.0.0.1:${port}/api/voice/samples`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-text": encodeURIComponent(text), "x-raw": encodeURIComponent("qual é o orsamento") }, body: Buffer.from(pcm.buffer) });
    assert.equal((await post("Qual é o orçamento do PRJ-ARARA?")).status, 201);
    assert.equal((await post("")).status, 400);
    const dir = path.join(voiceDir, "samples"), files = fs.readdirSync(dir).sort();
    assert.deepEqual(files.map(f => path.extname(f)), [".json", ".txt", ".wav"]);
    assert.equal(fs.readFileSync(path.join(dir, files[1]), "utf8"), "Qual é o orçamento do PRJ-ARARA?");
    assert.equal(fs.statSync(path.join(dir, files[2])).size, 44 + 32000);
  } finally { server.close(); }
});

test("nomes do notebook: grafia do STT (Alpha/Alfa, Metrology) volta ao nome real, em pt e en", () => {
  const terms = ["Metrologia Alfa", "Bianca Reis", "Armazém Claro", "Ararinha"];
  assert.equal(fixTerms("Quem é o dono do contrato com a metrologia Alpha?", terms), "Quem é o dono do contrato com a Metrologia Alfa?");
  assert.equal(fixTerms("What is the total value of the Metrology Alpha contract?", terms), "What is the total value of the Metrologia Alfa contract?");
  assert.equal(fixTerms("Quais projetos têm Bianka Reiss como patrocinadora?", terms), "Quais projetos têm Bianca Reis como patrocinadora?");
  assert.equal(fixTerms("Fale do Ararinha, por favor.", terms), "Fale do Ararinha, por favor.");
  assert.equal(fixTerms("Araringa agora", terms), "Araringa agora"); // nome de uma palavra só: só grafia equivalente, nada de aproximação
  // Sem alteração: frases comuns, nome parcial, palavra isolada parecida.
  assert.equal(fixTerms("Qual o status da linha clara de armazém?", terms), "Qual o status da linha clara de armazém?");
  assert.equal(fixTerms("A Bianca chegou.", terms), "A Bianca chegou.");
  assert.equal(fixTerms("Qualquer coisa", []), "Qualquer coisa");
});

test("extração de nomes: só nomes repetidos; começo de frase e cabeçalho de tabela não contam", () => {
  const docs = ["O contrato com a Metrologia Alfa venceu. Falou com Bianca Reis ontem.", "A Metrologia Alfa renovou. Depois Bianca Reis aprovou. Para o Gateway Industrial, veja a doc. O Gateway Industrial roda.", "| Fornecedor | Projeto |\nPara Fornecedor novo. Quando Fornecedor sair."];
  const t = extractTerms(docs);
  assert.ok(t.includes("Metrologia Alfa") && t.includes("Bianca Reis") && t.includes("Gateway Industrial"));
  assert.ok(!t.includes("Para") && !t.includes("Fornecedor") && !t.includes("Quando"));
});

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
  assert.equal(speechText("O prazo (30 dias) vale para o aluno(a) inscrito(s) (veja abaixo)."), "O prazo, 30 dias, vale para o aluno inscrito, veja abaixo.");
});

test("pronúncia pt-BR: termos em inglês na grafia falada e siglas soletradas", () => {
  assert.equal(pronouncePt("Faça o download do software e mande por e-mail"), "Faça o dáunloud do sóftuer e mande por imêiu");
  assert.equal(pronouncePt("os links dos sites e dos apps"), "os línques dos sáites e dos éps");
  assert.equal(pronouncePt("o home office e o Wi-Fi"), "o rôum ófis e o uaifái");
  assert.equal(pronouncePt("a API manda o PDF e os PDFs"), "a á pê í manda o pê dê éfe e os pê dê éfes");
  assert.equal(pronouncePt("o PRJ ARARA e o CNPJ"), "o pê érre jóta ARARA e o cê êne pê jóta");
  assert.equal(pronouncePt("no século XX, a NASA e o JSON"), "no século XX, a NASA e o djêisson");
  // Palavras portuguesas que só contêm um termo não mudam.
  assert.equal(pronouncePt("o website, a sitemap e o sitema"), "o uebsáite, a sitemap e o sitema");
});

test("normalização pt-BR: símbolos e abreviações", () => {
  assert.equal(normalizePt("temperatura ≥ 25 °C, aprox. 3x4 metros"), "temperatura maior ou igual a 25 graus Celsius, aproximadamente 3 por 4 metros");
  assert.equal(normalizePt("Ex.: entrada -> saída, ~30 itens"), "por exemplo entrada para saída, cerca de 30 itens");
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
