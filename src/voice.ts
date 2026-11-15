// Modo de voz: transcrição (STT) e síntese de fala (TTS) 100% locais com sherpa-onnx (ONNX em CPU).
// Independente do RAG: a pergunta transcrita segue pelo mesmo endpoint do chat; aqui só se converte áudio <-> texto.
// Modelos são baixados do Hugging Face na primeira utilização (ou com `npm run voice:download`) para VOICE_DIR.
import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { dataDir, db } from "./database.js";
import { extractCodes } from "./structured.js";

export const voiceDir = path.resolve(process.env.VOICE_DIR || path.join(dataDir, "voice"));
const enabled = process.env.VOICE_ENABLED !== "false";
const hfUrl = (process.env.VOICE_HF_URL || "https://huggingface.co").replace(/\/+$/, "");
const threads = Math.max(1, Number(process.env.VOICE_NUM_THREADS) || 4);
const whisperLanguage = process.env.VOICE_STT_LANGUAGE ?? "pt";

type Asset = { key: string; repo: string; dir: string; filter: RegExp; mb: number };
type SttModel = Asset & { label: string; config: (dir: string) => object };
type Voice = Asset & { label: string; lang: "pt" | "en"; onnx: string };

// espeak-ng (fonemas) é compartilhado por todas as vozes Piper; só os dados de português e inglês são baixados.
const ESPEAK: Asset = { key: "espeak", repo: "csukuangfj/vits-piper-pt_BR-faber-medium", dir: "", filter: /^espeak-ng-data\/(phon[a-z-]*|intonations|(pt|en)_dict|lang\/(roa\/pt|gmw\/en)[^/]*)$/, mb: 6 };
const whisper = (size: string, label: string, mb: number): SttModel => ({ key: `whisper-${size}`, label, mb, repo: `csukuangfj/sherpa-onnx-whisper-${size}`, dir: `stt/whisper-${size}`, filter: new RegExp(`^${size}-(encoder\\.int8\\.onnx|decoder\\.int8\\.onnx|tokens\\.txt)$`),
  config: d => ({ whisper: { encoder: `${d}/${size}-encoder.int8.onnx`, decoder: `${d}/${size}-decoder.int8.onnx`, language: whisperLanguage, task: "transcribe" }, tokens: `${d}/${size}-tokens.txt` }) });
const STT: Record<string, SttModel> = {
  // Parakeet TDT v3 (NVIDIA): 25 idiomas europeus com pontuação; ~0,25 s por pergunta curta em CPU, mais preciso que o Whisper small.
  parakeet: { key: "parakeet", label: "Parakeet TDT 0.6B v3", mb: 670, repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", dir: "stt/parakeet", filter: /^((encoder|decoder|joiner)\.int8\.onnx|tokens\.txt)$/,
    config: d => ({ transducer: { encoder: `${d}/encoder.int8.onnx`, decoder: `${d}/decoder.int8.onnx`, joiner: `${d}/joiner.int8.onnx` }, modelType: "nemo_transducer", tokens: `${d}/tokens.txt` }) },
  "whisper-base": whisper("base", "Whisper base", 160),
  "whisper-small": whisper("small", "Whisper small", 375),
  // Precisão máxima: ~16% menos erros que o Parakeet em português, mas ~3 s por pergunta em CPU e ~2 GB de RAM.
  "whisper-turbo": whisper("turbo", "Whisper large-v3 turbo", 1040),
};
const piper = (key: string, name: string, label: string, lang: "pt" | "en"): Voice => ({ key, label, lang, onnx: `${name}.onnx`, mb: 63, repo: `csukuangfj/vits-piper-${name}`, dir: `voices/${key}`, filter: new RegExp(`^(${name.replace(/[.]/g, "\\.")}\\.onnx|tokens\\.txt)$`) });
export const VOICES: Record<string, Voice> = {
  faber: piper("faber", "pt_BR-faber-medium", "Faber · grave e calmo", "pt"),
  cadu: piper("cadu", "pt_BR-cadu-medium", "Cadu · natural", "pt"),
  jeff: piper("jeff", "pt_BR-jeff-medium", "Jeff · jovem", "pt"),
  alan: piper("alan", "en_GB-alan-medium", "Alan · britânico", "en"),
  northern: piper("northern", "en_GB-northern_english_male-medium", "Northern · britânico", "en"),
};
const sttKey = STT[process.env.VOICE_STT_MODEL || ""] ? String(process.env.VOICE_STT_MODEL) : "parakeet";
const pickVoice = (key: unknown, lang: "pt" | "en") => { const v = VOICES[String(key)]; return v && v.lang === lang ? v.key : lang === "pt" ? "faber" : "alan"; };

// ---------- Download dos modelos ----------
const marker = (a: Asset) => path.join(voiceDir, `.ok-${a.key}`);
const isReady = (a: Asset) => fs.existsSync(marker(a));
type Job = { status: "idle" | "running" | "ready" | "error"; stage: string; done: number; total: number; error?: string };
let job: Job = { status: "idle", stage: "", done: 0, total: 0 }, running: Promise<void> | null = null;

// Sem rede (ou proxy que segura a conexão) a consulta ficaria pendurada: falha rápido e diz onde pôr os modelos.
const offlineHint = `Copie os modelos já baixados (npm run voice:download) para ${voiceDir}.`;
async function listFiles(a: Asset) {
  const r = await fetch(`${hfUrl}/api/models/${a.repo}/tree/main?recursive=true`, { signal: AbortSignal.timeout(15_000) })
    .catch(e => { throw Error(`Modelos de voz ausentes e sem acesso a ${hfUrl} (${e instanceof Error ? e.message : e}). ${offlineHint}`); });
  if (!r.ok) throw Error(`Não foi possível listar ${a.repo} (HTTP ${r.status}). ${offlineHint}`);
  const files = ((await r.json()) as { type: string; path: string; size: number }[]).filter(f => f.type === "file" && a.filter.test(f.path));
  if (!files.length) throw Error(`Nenhum arquivo encontrado em ${a.repo}.`);
  return files;
}
async function download(a: Asset, files: { path: string; size: number }[]) {
  let next = 0;
  // Arquivos já presentes com o tamanho certo não são baixados de novo (retomada após falha).
  const worker = async () => { for (let f = files[next++]; f; f = files[next++]) {
    const dest = path.join(voiceDir, a.dir, f.path), stat = await fsp.stat(dest).catch(() => null);
    if (stat?.size === f.size) { job.done += f.size; continue; }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const r = await fetch(`${hfUrl}/${a.repo}/resolve/main/${f.path}`);
    if (!r.ok || !r.body) throw Error(`Falha ao baixar ${f.path} (HTTP ${r.status}).`);
    const tmp = `${dest}.part`, out = fs.createWriteStream(tmp);
    try { for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) { job.done += chunk.length; if (!out.write(chunk)) await once(out, "drain"); } out.end(); await once(out, "finish"); }
    catch (e) { out.destroy(); await fsp.rm(tmp, { force: true }); throw e; }
    await fsp.rename(tmp, dest);
  } };
  await Promise.all(Array.from({ length: Math.min(6, files.length) }, worker));
  await fsp.writeFile(marker(a), new Date().toISOString());
}
export async function ensureAssets(voices: string[], onStage: (s: string) => void = () => {}) {
  const needed = [ESPEAK, STT[sttKey], ...new Set(voices.map(v => VOICES[v]).filter(Boolean))].filter(a => !isReady(a));
  if (!needed.length) return;
  onStage("Verificando modelos…");
  const lists = await Promise.all(needed.map(listFiles));
  job.done = 0; job.total = lists.flat().reduce((s, f) => s + f.size, 0);
  for (let i = 0; i < needed.length; i++) { const a = needed[i] as Asset & { label?: string }; onStage(`Baixando ${a.label ? `${a.label.split(" ·")[0]} (${a.mb} MB)` : "dados de pronúncia"}…`); await download(a, lists[i]); }
}

// ---------- Modelos carregados (uma instância por modelo, chamadas em fila: CPU é o gargalo) ----------
let sherpa: any = null;
const loadSherpa = () => sherpa ??= require("sherpa-onnx-node");
const queue = () => { let tail: Promise<unknown> = Promise.resolve(); return <T>(fn: () => Promise<T>): Promise<T> => { const p = tail.then(fn, fn); tail = p.catch(() => {}); return p; }; };
const sttQueue = queue(), ttsQueue = queue();
let recognizer: Promise<any> | null = null;
const ttsModels = new Map<string, Promise<any>>();
const getRecognizer = () => recognizer ??= (async () => {
  const m = STT[sttKey];
  if (!isReady(m)) throw Error("Modelo de transcrição não baixado.");
  return loadSherpa().OfflineRecognizer.createAsync({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: { ...m.config(path.join(voiceDir, m.dir).replace(/\\/g, "/")), numThreads: threads, provider: "cpu", debug: false } });
})().catch(e => { recognizer = null; throw e; });
const getTts = (key: string) => {
  let p = ttsModels.get(key);
  if (!p) {
    const v = VOICES[key], d = path.join(voiceDir, v.dir).replace(/\\/g, "/");
    if (!isReady(v) || !isReady(ESPEAK)) throw Error(`Voz ${v.label} não baixada.`);
    p = loadSherpa().OfflineTts.createAsync({ model: { vits: { model: `${d}/${v.onnx}`, tokens: `${d}/tokens.txt`, dataDir: path.join(voiceDir, "espeak-ng-data").replace(/\\/g, "/") }, numThreads: Math.min(2, threads), provider: "cpu", debug: false }, maxNumSentences: 1 }) as Promise<any>;
    p.catch(() => ttsModels.delete(key)); ttsModels.set(key, p);
  }
  return p;
};

// Baixa o que faltar e deixa os modelos carregados e "aquecidos" (a 1ª inferência do ONNX é mais lenta).
export function prepare(voices: string[]) {
  const all = [...new Set(voices.filter(v => VOICES[v]))];
  if (running) return running;
  job = { status: "running", stage: "Preparando…", done: 0, total: 0 };
  running = (async () => {
    try {
      await ensureAssets(all, s => job.stage = s);
      job.stage = "Carregando modelos de voz…";
      const rec = await getRecognizer(), s = rec.createStream();
      s.acceptWaveform({ samples: new Float32Array(8000), sampleRate: 16000 }); await sttQueue(() => rec.decodeAsync(s));
      for (const v of all) { const tts = await getTts(v); await ttsQueue(() => tts.generateAsync({ text: VOICES[v].lang === "pt" ? "Olá." : "Hello.", sid: 0, speed: 1 })); }
      job = { status: "ready", stage: "", done: job.total, total: job.total };
    } catch (e) {
      job = { ...job, status: "error", error: e instanceof Error ? e.message : String(e) };
    } finally { running = null; }
  })();
  return running;
}

export async function transcribe(pcm: Int16Array) {
  if (pcm.length < 16000 * 0.25) return "";
  // Sem margem extra de silêncio: o navegador já envia até 0,6 s antes da fala, e margens maiores pioraram frases curtas nos testes.
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
  const rec = await getRecognizer();
  const text = await sttQueue(async () => { const s = rec.createStream(); s.acceptWaveform({ samples, sampleRate: 16000 }); await rec.decodeAsync(s); return String(rec.getResult(s).text || "").trim(); });
  return text.replace(/^[A-Z]{2,}\d[A-Z0-9]*\s+(?=\S)/, ""); // token espúrio ocasional do Parakeet no início ("RKA4JL Qual é…")
}

// ---------- Códigos do notebook na fala ----------
// Falados, "APP-MES" vira "app mês" e "FOR-002" vira "for002"; o RAG prioriza códigos exatos, então a transcrição é
// reescrita com os códigos (maiúsculos, como o RAG extrai) que existem no notebook. Só leitura dos trechos indexados.
const plain = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const lev1 = (a: string, b: string) => { // distância de edição <= 1?
  if (a === b) return true; if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i);
};
export function fixCodes(text: string, codes: string[]) {
  const vocab = codes.map(c => ({ code: c, key: plain(c), head: plain(c.split("-")[0]), parts: c.split("-").length })).filter(v => v.key.length >= 3);
  if (!vocab.length) return text;
  const words = text.split(/\s+/).filter(Boolean), out: string[] = [];
  for (let i = 0; i < words.length;) {
    let hit: { code: string; n: number } | null = null;
    // Trechos de até 4 palavras sem pontuação no meio; primeiro o casamento exato, depois o aproximado:
    // 1 letra de diferença só quando o prefixo (antes do hífen) foi ouvido certo ("SRV Mau" -> SRV-MAO).
    let max = 1; while (max < 4 && i + max < words.length && !/[.,;:!?…]$/.test(words[i + max - 1])) max++;
    for (const exact of [true, false]) for (let n = max; n >= 1 && !hit; n--) {
      const span = words.slice(i, i + n).join(""), key = plain(span), head = plain(words[i]);
      if (!key || span.includes("-")) continue; // já escrito com hífen ("bem-sucedido", "APP-MES"): mantém como foi transcrito
      // Aproximado em uma palavra só ("Apmes" -> APP-MES) exige as 2 primeiras letras e não pode ser palavra comum (minúscula).
      const v = exact ? vocab.find(v => v.key === key) : vocab.find(v => v.key.length >= 5 && lev1(key, v.key) && (n >= 2 ? head === v.head : key.slice(0, 2) === v.key.slice(0, 2) && /^[A-Z]/.test(words[i])));
      if (v && n <= v.parts + 2) hit = { code: v.code, n };
    }
    if (hit) { out.push(hit.code + (words[i + hit.n - 1].match(/[.,;:!?…]+$/)?.[0] || "")); i += hit.n; } else out.push(words[i++]);
  }
  return out.join(" ");
}
const codeCache = new Map<string, { count: number; codes: string[] }>();
function notebookCodes(notebookId: string) {
  const count = (db.prepare("SELECT count(*) AS n FROM chunks WHERE notebook_id=?").get(notebookId) as { n: number }).n;
  const hit = codeCache.get(notebookId);
  if (hit && hit.count === count) return hit.codes;
  const codes = new Set<string>();
  for (const r of db.prepare("SELECT content FROM chunks WHERE notebook_id=?").iterate(notebookId) as Iterable<{ content: string }>)
    for (const c of extractCodes(r.content)) if (/^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$/.test(c)) codes.add(c);
  const list = [...codes]; codeCache.set(notebookId, { count, codes: list });
  return list;
}

// ---------- Texto para fala ----------
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const date = (d: string, m: string, y: string, raw: string) => +m >= 1 && +m <= 12 && +d >= 1 && +d <= 31 ? `${+d} de ${MONTHS[+m - 1]} de ${y}` : raw;
// Remove marcação (markdown, tabelas, citações de fonte, links, emojis) que não deve ser lida em voz alta.
export function speechText(text: string) {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ").replace(/\[Fonte[^\]]*\]/gi, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<https?:[^>]+>|https?:\/\/\S+/g, "")
    .replace(/^\s*\|?(\s*:?-{2,}:?\s*\|?)+\s*$/gm, "").replace(/\s*\|\s*/g, ", ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/^\s*>\s?/gm, "").replace(/^\s*[-*+•]\s+/gm, "").replace(/^\s*(\d+)[.)]\s+/gm, "$1, ")
    .replace(/(\*\*|__|~~|`)/g, "").replace(/(?<![\p{L}\p{N}])[*_]+|[*_]+(?![\p{L}\p{N}])/gu, "")
    .replace(/<\/?[a-z][^>]*>/gi, " ").replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ").replace(/(\s*,\s*){2,}/g, ", ").replace(/^[\s,;:]+|[\s,;]+$/g, "").trim();
}
// Números, moeda, datas e unidades em pt-BR: o espeak-ng lê mal "R$ 1.250.000,50", "01/03/2024" ou "14h30".
export function normalizePt(text: string) {
  const unit = (n: string, cur: string, scale?: string) => `${n.replace(/\.(?=\d{3})/g, "")}${scale ? ` ${scale} de` : ""} ${cur}`;
  return text
    .replace(/(R\$|US\$|€)\s?(\d[\d.]*)(?:,(\d{1,2}))?(?:\s?(mil|milhões|milhão|bilhões|bilhão|trilhões|trilhão)\b)?/gi, (_, sym: string, int: string, dec: string | undefined, scale: string | undefined) => {
      const cur = sym === "€" ? "euros" : sym.toUpperCase() === "US$" ? "dólares" : "reais";
      if (scale) return `${int.replace(/\.(?=\d{3})/g, "")}${dec ? `,${dec}` : ""} ${scale}${/^mil$/i.test(scale) ? "" : " de"} ${cur}`;
      const cents = dec ? Number(dec.padEnd(2, "0")) : 0, base = unit(int, cur);
      return cents ? `${base}, e ${cents} centavo${cents === 1 ? "" : "s"}` : base;
    })
    .replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (m, d, mo, y) => date(d, mo, y, m))
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => date(d, mo, y, m))
    .replace(/\b(\d{1,2})\s?h\s?(\d{2})(?:min)?\b/gi, (_, h, m) => `${+h} ${+h === 1 ? "hora" : "horas"}${+m ? ` e ${+m}` : ""}`)
    .replace(/\b(\d{1,2})\s?h\b/gi, (_, h) => `${+h} ${+h === 1 ? "hora" : "horas"}`)
    .replace(/\b(\d{1,3}(?:\.\d{3})+)(?![\d.])/g, m => m.replace(/\./g, ""))
    .replace(/(\d)\s?%/g, "$1 por cento")
    .replace(/(\d)\s?km\/h\b/gi, "$1 quilômetros por hora").replace(/(\d)\s?km\b/gi, "$1 quilômetros").replace(/(\d)\s?kg\b/gi, "$1 quilos")
    .replace(/(\d)\s?m²/g, "$1 metros quadrados").replace(/(\d)\s?m³/g, "$1 metros cúbicos")
    .replace(/\bn[º°.]\s?(?=\d)/gi, "número ").replace(/\b(\d+)\s?[-–]\s?(\d+)\b/g, "$1 a $2")
    .replace(/\b([A-Z0-9]{2,})[-_]([A-Z0-9]{2,})\b/g, "$1 $2").replace(/\be\/ou\b/gi, "e ou").replace(/(\p{L})\/(\p{L})/gu, "$1 ou $2")
    .replace(/\bvs\.?(?=\s)/gi, "versus").replace(/\betc\./gi, "etcétera.");
}
// Idioma da resposta (só pt/en): decide a voz. Sem sinal claro, português.
export function detectLang(text: string): "pt" | "en" {
  const en = (text.match(/\b(the|and|is|are|of|to|with|for|this|that|you|it|was|on|be|have|has|what|which|from|there|can|will|not)\b/gi) || []).length;
  const pt = (text.match(/\b(o|os|as|de|do|da|dos|das|é|em|no|na|um|uma|que|para|com|não|por|são|ao|está|isso|mais)\b/gi) || []).length + (/[ãõçáéíóúâêô]/i.test(text) ? 3 : 0);
  return en >= 2 && en > pt * 1.5 ? "en" : "pt";
}
const wav = (samples: Float32Array, rate: number) => {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return b;
};
export async function speak(text: string, opts: { voice?: string; voiceEn?: string; speed?: number; context?: string; signal?: AbortSignal } = {}) {
  const lang = detectLang(`${opts.context || ""} ${text}`), clean = speechText(text), spoken = lang === "pt" ? normalizePt(clean) : clean;
  if (!/[\p{L}\p{N}]/u.test(spoken)) return null;
  const key = pickVoice(lang === "pt" ? opts.voice : opts.voiceEn, lang), tts = await getTts(key);
  const speed = Math.min(1.5, Math.max(0.7, Number(opts.speed) || 1));
  return ttsQueue(async () => {
    if (opts.signal?.aborted) return null; // pedido cancelado enquanto esperava na fila (usuário interrompeu)
    const a = await tts.generateAsync({ text: spoken, sid: 0, speed });
    return wav(a.samples, a.sampleRate);
  });
}

// ---------- Rotas (/api/voice, exigem login) ----------
export function voiceRouter() {
  const r = express.Router();
  r.use((_req, res, next) => enabled ? next() : res.status(404).json({ error: "Modo de voz desativado (VOICE_ENABLED=false)." }));
  r.get("/status", (_req, res) => res.json({
    stt: { key: sttKey, label: STT[sttKey].label, mb: STT[sttKey].mb, ready: isReady(STT[sttKey]) && isReady(ESPEAK) },
    voices: Object.values(VOICES).map(v => ({ key: v.key, label: v.label, lang: v.lang, mb: v.mb, ready: isReady(v) })),
    job,
  }));
  r.post("/prepare", (req, res) => {
    const voices = [pickVoice(req.body?.voice, "pt"), pickVoice(req.body?.voiceEn, "en")];
    const loaded = !running && recognizer && voices.every(v => ttsModels.has(v) && isReady(VOICES[v]));
    if (!loaded) void prepare(voices);
    res.json(loaded ? { status: "ready", stage: "", done: 0, total: 0 } : job);
  });
  r.post("/transcribe", express.raw({ type: "application/octet-stream", limit: "4mb" }), async (req, res) => {
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length % 2) return res.status(400).json({ error: "Envie áudio PCM 16 bits, 16 kHz, mono." });
    const started = Date.now();
    try {
      const raw = await transcribe(new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)));
      const nb = String(req.query.notebook || ""), text = raw && nb ? fixCodes(raw, notebookCodes(nb)) : raw;
      res.json({ text, raw, ms: Date.now() - started });
    }
    catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
  });
  r.post("/speak", async (req, res) => {
    const text = String(req.body?.text || "").slice(0, 2000);
    const abort = new AbortController(); res.on("close", () => { if (!res.writableFinished) abort.abort(); });
    try {
      const audio = await speak(text, { voice: req.body?.voice, voiceEn: req.body?.voiceEn, speed: req.body?.speed, context: String(req.body?.context || "").slice(0, 600), signal: abort.signal });
      if (!audio) return void res.sendStatus(204);
      res.set({ "content-type": "audio/wav", "cache-control": "no-store" }).send(audio);
    } catch (e) { if (!res.headersSent) res.status(500).json({ error: e instanceof Error ? e.message : String(e) }); }
  });
  return r;
}
