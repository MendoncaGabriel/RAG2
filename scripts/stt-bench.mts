// Benchmark da transcrição (STT) com fala real: roda o mesmo `transcribe()` do servidor sobre uma pasta de áudios com o texto certo.
// Uso: VOICE_STT_MODEL=parakeet npx tsx scripts/stt-bench.mts --dir <pasta> [--n 60] [--lang pt|en] [--show 5]
// A pasta pode ter pares `nome.wav` + `nome.txt` (gravações próprias) ou o formato do FLEURS (`dev.tsv` + wavs em subpastas).
// Compare modelos rodando de novo com outro VOICE_STT_MODEL (os modelos precisam estar em VOICE_DIR: npm run voice:download).
import fs from "node:fs";
import path from "node:path";
import { transcribe } from "../src/voice.js";

const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const dir = arg("dir"), N = Number(arg("n", "60")), lang = arg("lang", "pt"), show = Number(arg("show", "5"));
if (!dir || !fs.existsSync(dir)) { console.error("Informe --dir <pasta com .wav + .txt ou dev.tsv do FLEURS>."); process.exit(1); }

// WAV PCM 16/32 bits ou float, qualquer taxa: canal 1, reamostrado para 16 kHz (linear) como Int16, igual ao que o navegador envia.
function readWav(file: string) {
  const b = fs.readFileSync(file); let o = 12, fmt: { tag: number; ch: number; rate: number; bits: number } | undefined, data: Buffer | undefined;
  while (o + 8 <= b.length) { const id = b.toString("ascii", o, o + 4), sz = b.readUInt32LE(o + 4); if (id === "fmt ") fmt = { tag: b.readUInt16LE(o + 8), ch: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) }; if (id === "data") { data = b.subarray(o + 8, o + 8 + sz); break; } o += 8 + sz + (sz & 1); }
  if (!fmt || !data) throw Error(`WAV inválido: ${file}`);
  const bps = fmt.bits / 8, n = Math.floor(data.length / bps / fmt.ch), x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i * bps * fmt.ch; x[i] = fmt.bits === 16 ? data.readInt16LE(p) / 32768 : fmt.tag === 3 ? data.readFloatLE(p) : data.readInt32LE(p) / 2147483648; }
  const r = fmt.rate / 16000, m = Math.floor(n / r), out = new Int16Array(m);
  for (let i = 0; i < m; i++) { const a = i * r, k = Math.floor(a), f = a - k, v = x[k] * (1 - f) + (x[k + 1] ?? x[k]) * f; out[i] = Math.round(Math.max(-1, Math.min(1, v)) * 32767); }
  return out;
}
function items() {
  const wavs = new Map<string, string>(), walk = (d: string) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(path.join(d, f.name)) : f.name.endsWith(".wav") && wavs.set(f.name, path.join(d, f.name)); };
  walk(dir);
  const tsv = ["dev.tsv", "test.tsv"].map(f => path.join(dir, f)).find(f => fs.existsSync(f)), seen = new Set<string>();
  const list = tsv
    ? fs.readFileSync(tsv, "utf8").split("\n").map(l => l.split("\t")).filter(r => wavs.has(r[1]) && !seen.has(r[1]) && seen.add(r[1])).map(r => ({ file: wavs.get(r[1])!, ref: r[2] }))
    : [...wavs.values()].filter(f => fs.existsSync(f.replace(/\.wav$/, ".txt"))).sort().map(f => ({ file: f, ref: fs.readFileSync(f.replace(/\.wav$/, ".txt"), "utf8").trim() }));
  return list.slice(0, N);
}
// WER sem pontuação e sem caixa; números de 0 a 10 por extenso (o gabarito costuma escrever "dez"; o modelo, "10").
const NUM: Record<string, string[]> = { pt: "zero um dois três quatro cinco seis sete oito nove dez".split(" "), en: "zero one two three four five six seven eight nine ten".split(" ") };
const words = (s: string, accents: boolean) => { let t = s.toLowerCase().replace(/\b(\d|10)\b/g, d => (NUM[lang] || NUM.pt)[+d]); if (!accents) t = t.normalize("NFD").replace(/[̀-ͯ]/g, ""); return t.replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean); };
const edits = (r: string[], h: string[]) => { let prev = Array.from({ length: h.length + 1 }, (_, j) => j); for (let i = 1; i <= r.length; i++) { const cur = [i]; for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1)); prev = cur; } return prev[h.length]; };

const list = items();
if (!list.length) { console.error("Nenhum par áudio + texto encontrado."); process.exit(1); }
await transcribe(new Int16Array(16000)); // carrega e aquece o modelo fora da medição
let e = 0, ea = 0, total = 0, ms = 0, audio = 0; const bad: { w: number; ref: string; hyp: string }[] = [];
for (const it of list) {
  const pcm = readWav(it.file), t0 = Date.now(), hyp = await transcribe(pcm); ms += Date.now() - t0; audio += pcm.length / 16000;
  const r = words(it.ref, false), d = edits(r, words(hyp, false)); e += d; ea += edits(words(it.ref, true), words(hyp, true)); total += r.length;
  bad.push({ w: d / Math.max(1, r.length), ref: it.ref, hyp });
}
console.log(`STT ${process.env.VOICE_STT_MODEL || "parakeet"} · ${list.length} frases de ${dir}`);
console.log(`WER ${(e / total * 100).toFixed(1)}% (contando acentos ${(ea / total * 100).toFixed(1)}%) · ${(ms / list.length / 1000).toFixed(2)} s por frase · ${(ms / 1000 / audio).toFixed(2)} s por s de áudio`);
for (const b of bad.sort((a, b) => b.w - a.w).slice(0, show)) console.log(`  ${(b.w * 100).toFixed(0)}%  certo: ${b.ref}\n       ouvido: ${b.hyp}`);
