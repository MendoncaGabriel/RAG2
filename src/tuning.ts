// Ajuste automático ao computador: roda na inicialização, antes do servidor aceitar conexões, e serve para qualquer PC.
// 1) Detecta CPU (núcleos físicos/lógicos), RAM e GPU.
// 2) Mede no próprio PC, com o modelo de chat ativo, quantas threads deixam o Ollama mais rápido (leitura do prompt + geração)
//    e guarda o resultado em data/tuning.json (chave: hardware + servidor + versão do Ollama + modelo). "npm run tune" mede de novo.
//    Se o modelo roda inteiro na GPU, as threads quase não importam e a varredura é pulada.
// 3) Pré-carrega embeddings e chat com as mesmas opções das perguntas (num_ctx/num_thread iguais: o Ollama não recarrega),
//    e avisa quando a GPU está ociosa ou quando chat e embeddings se expulsam da memória a cada pergunta.
// Medido no Ryzen 7 7735U (8 núcleos, qwen2.5 1.5b/3b): leitura do prompt é o gargalo (≈1200–1500 tokens de contexto);
// núcleos − 1 deu o melhor equilíbrio na CPU; num_batch (256–1024) e num_ctx (3072–8192) não mudaram a velocidade (num_ctx só
// reserva memória: +270 MB de 3072 para 8192 no 3b). Por isso o num_ctx continua no perfil do modelo (modelprofile.ts),
// dimensionado para nunca truncar prompt + histórico + resposta, e o ajuste mexe só nas threads.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { dbPath } from "./database.js";
import { isReasoningOnly } from "./modelprofile.js";

export interface Hardware { cpu: string; logical: number; physical: number; ramGB: number; freeGB: number; gpus: string[] }
export interface TuneTarget { baseUrl: string; apiKey?: string; chatModel: string; contextTokens: number; embedding?: { baseUrl: string; apiKey?: string; model: string } }
export type Sample = { threads: number; promptTps: number; evalTps: number; seconds: number };
export interface TuneResult { key: string; at: string; baseUrl: string; model: string; numThread?: number; device: "cpu" | "gpu" | "misto"; samples: Sample[] }

const exec = promisify(execFile);
const cacheFile = () => path.join(path.dirname(dbPath), "tuning.json");
let current: TuneResult | null = null;

// Threads usadas nas chamadas ao Ollama: OLLAMA_NUM_THREAD (sobrescrita manual) > valor medido para este servidor > padrão do Ollama.
export function tunedThreads(baseUrl: string): number | undefined {
  const manual = Number(process.env.OLLAMA_NUM_THREAD);
  if (manual > 0) return manual;
  return current && current.baseUrl === baseUrl ? current.numThread : undefined;
}
export const tuningSummary = () => current;

// ---------- Hardware ----------
// Núcleos físicos no Linux: pares (physical id, core id) distintos de /proc/cpuinfo.
export function physicalFromCpuinfo(text: string): number | undefined {
  const cores = new Set<string>();
  let socket = "0";
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
    if (k === "physical id") socket = v;
    else if (k === "core id") cores.add(`${socket}:${v}`);
  }
  return cores.size || undefined;
}
const pciVendors: Record<string, string> = { "0x10de": "NVIDIA", "0x1002": "AMD", "0x8086": "Intel" };
// Adaptadores que não fazem inferência (vídeo remoto, driver genérico).
export const realGpus = (names: string[]) => names.filter(n => n && !/basic (display|render)|remote|virtual|hyper-v|citrix|vmware|parsec|dameware|displaylink|mirror/i.test(n));

export async function detectHardware(): Promise<Hardware> {
  const cpus = os.cpus(), logical = os.availableParallelism?.() || cpus.length || 1;
  let physical: number | undefined, gpus: string[] = [];
  try {
    if (process.platform === "win32") {
      const ps = "$p=Get-CimInstance Win32_Processor;$g=Get-CimInstance Win32_VideoController;@{cores=($p|Measure-Object NumberOfCores -Sum).Sum;gpus=@($g|ForEach-Object{$_.Name})}|ConvertTo-Json -Compress";
      const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 15_000, windowsHide: true });
      const d = JSON.parse(stdout);
      physical = Number(d.cores) || undefined;
      gpus = [d.gpus].flat().filter(Boolean).map(String);
    } else if (process.platform === "linux") {
      physical = physicalFromCpuinfo(fs.readFileSync("/proc/cpuinfo", "utf8"));
      for (const card of fs.readdirSync("/sys/class/drm").filter(c => /^card\d+$/.test(c))) {
        try { const v = pciVendors[fs.readFileSync(`/sys/class/drm/${card}/device/vendor`, "utf8").trim()]; if (v && !gpus.includes(v)) gpus.push(v); } catch {}
      }
    } else if (process.platform === "darwin") {
      physical = Number((await exec("sysctl", ["-n", "hw.physicalcpu"], { timeout: 5_000 })).stdout) || undefined;
      if (process.arch === "arm64") gpus = ["Apple Silicon (Metal)"];
    }
  } catch { /* sem detalhes: usa os núcleos lógicos */ }
  // Contêiner com CPU limitada: não passar do que o processo enxerga.
  physical = Math.min(physical || logical, logical);
  const gb = (b: number) => Math.round(b / 1073741824 * 10) / 10;
  return { cpu: (cpus[0]?.model || "CPU").trim().replace(/\s+/g, " "), logical, physical, ramGB: gb(os.totalmem()), freeGB: gb(os.freemem()), gpus: realGpus(gpus) };
}

// ---------- Escolha das threads ----------
// Candidatas: metade, 75%, núcleos − 1 e todos os núcleos físicos (SMT/hyperthreading não ajuda o llama.cpp).
export function threadCandidates(physical: number): number[] {
  const p = Math.max(1, Math.floor(physical));
  return [...new Set([Math.ceil(p / 2), Math.round(p * 0.75), p - 1, p].filter(n => n >= 1))].sort((a, b) => a - b);
}
// Tempo estimado de uma resposta típica do RAG: ≈1300 tokens de prompt (contexto recuperado) e ≈150 de resposta, como no benchmark.
export const answerSeconds = (promptTps: number, evalTps: number) => 1300 / promptTps + 150 / evalTps;
// Melhor tempo; empate técnico (até 3% do melhor) fica com menos threads, deixando CPU livre para o app, a busca e o modo de voz.
export function pickThreads(samples: Sample[]): number | undefined {
  const ok = samples.filter(s => Number.isFinite(s.seconds) && s.seconds > 0);
  if (!ok.length) return undefined;
  const best = Math.min(...ok.map(s => s.seconds));
  return ok.filter(s => s.seconds <= best * 1.03).sort((a, b) => a.threads - b.threads)[0].threads;
}

// ---------- Ollama ----------
async function ollama(baseUrl: string, apiKey: string | undefined, route: string, body?: unknown, timeout = 180_000): Promise<any> {
  const res = await fetch(`${baseUrl}${route}`, { method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`Ollama ${route} (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
const withTag = (m: string) => (m.includes(":") ? m : `${m}:latest`);
async function loaded(baseUrl: string, apiKey?: string) {
  const ps = await ollama(baseUrl, apiKey, "/api/ps", undefined, 10_000).catch(() => ({ models: [] }));
  return ((ps.models || []) as any[]).map(m => ({ name: withTag(String(m.name || m.model)), size: Number(m.size) || 0, vram: Number(m.size_vram) || 0 }));
}
const deviceOf = (m?: { size: number; vram: number }): TuneResult["device"] | undefined => !m ? undefined : m.vram <= 0 ? "cpu" : m.vram >= m.size * 0.98 ? "gpu" : "misto";

// Prompt de medição (~600 tokens) parecido com o do RAG; o prefixo aleatório impede o Ollama de reaproveitar o cache do prompt.
function probeMessages() {
  const rows = Array.from({ length: 30 }, (_, i) => `Registro PRJ-${100 + i}: responsável setor ${i % 7 + 1}, prazo de ${10 + i * 3} dias, orçamento R$ ${(i + 2) * 12_500}, situação ${i % 3 ? "ativo" : "em revisão"}.`);
  return [
    { role: "system", content: `[${Date.now()}-${Math.random().toString(36).slice(2)}] Responda em português usando somente o contexto.` },
    { role: "user", content: `<contexto>\n${rows.join("\n")}\n</contexto>\n\nPergunta: liste os registros PRJ-100 a PRJ-115 com responsável, prazo e orçamento.` },
  ];
}
async function measure(t: TuneTarget, threads: number): Promise<Sample> {
  const base = { model: t.chatModel, stream: false, keep_alive: "30m", ...(isReasoningOnly(t.chatModel) ? {} : { think: false }) };
  const options = { num_ctx: t.contextTokens, num_thread: threads };
  // 1ª chamada carrega o modelo com estas opções (trocar num_thread recarrega); a 2ª é a medida.
  await ollama(t.baseUrl, t.apiKey, "/api/chat", { ...base, messages: [{ role: "user", content: "OK" }], options: { ...options, num_predict: 1 } });
  const r = await ollama(t.baseUrl, t.apiKey, "/api/chat", { ...base, messages: probeMessages(), options: { ...options, temperature: 0, num_predict: 64 } });
  const promptTps = r.prompt_eval_count / (r.prompt_eval_duration / 1e9), evalTps = r.eval_count / (r.eval_duration / 1e9);
  return { threads, promptTps: Math.round(promptTps * 10) / 10, evalTps: Math.round(evalTps * 10) / 10, seconds: Math.round(answerSeconds(promptTps, evalTps) * 100) / 100 };
}

function readCache(): Record<string, TuneResult> { try { return JSON.parse(fs.readFileSync(cacheFile(), "utf8")); } catch { return {}; } }
function writeCache(r: TuneResult) {
  const all = readCache();
  all[r.key] = r;
  try { fs.writeFileSync(cacheFile(), JSON.stringify(all, null, 2)); } catch (e) { console.warn("[Ajuste] não foi possível salvar o ajuste:", e instanceof Error ? e.message : e); }
}
export const tuneKey = (hw: Hardware, baseUrl: string, version: string, model: string) => JSON.stringify([hw.cpu, hw.physical, hw.logical, Math.round(hw.ramGB), baseUrl, version, model]);

async function sweep(t: TuneTarget, hw: Hardware, key: string, log: (m: string) => void): Promise<TuneResult> {
  const samples: Sample[] = [];
  const at = new Date().toISOString(), done = (numThread: number | undefined, device: TuneResult["device"]) => ({ key, at, baseUrl: t.baseUrl, model: t.chatModel, numThread, device, samples });
  const candidates = threadCandidates(hw.physical);
  log(`medindo ${t.chatModel} com ${candidates.join(", ")} threads (só na 1ª vez neste PC/modelo; leva de 20 s a 2 min)…`);
  const one = async (n: number) => { const s = await measure(t, n); samples.push(s); log(`  ${String(n).padStart(2)} threads: prompt ${s.promptTps} tok/s · geração ${s.evalTps} tok/s · resposta típica ≈ ${s.seconds} s`); };
  // Começa pelo total de núcleos: se o modelo ficou inteiro na GPU, as threads não importam e o resto da varredura é dispensado.
  await one(candidates[candidates.length - 1]);
  const device = deviceOf((await loaded(t.baseUrl, t.apiKey)).find(m => m.name === withTag(t.chatModel))) || "cpu";
  if (device === "gpu") return done(undefined, "gpu");
  for (const n of candidates.slice(0, -1).reverse()) await one(n);
  // Refina em volta da melhor (±1) quando o vizinho não foi medido.
  const best = pickThreads(samples)!;
  for (const n of [best - 1, best + 1]) if (n >= 1 && n <= hw.physical && !samples.some(s => s.threads === n)) await one(n);
  return done(pickThreads(samples), device);
}

const isLocal = (url: string) => /^https?:\/\/(localhost|127\.|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal)/i.test(url);

export async function autoTune(t: TuneTarget | null, opts: { force?: boolean; log?: (m: string) => void } = {}): Promise<TuneResult | null> {
  const log = opts.log || ((m: string) => console.info(`[Ajuste] ${m}`));
  const t0 = Date.now();
  const hw = await detectHardware();
  log(`${hw.cpu} · ${hw.physical} núcleos físicos / ${hw.logical} lógicos · RAM ${hw.ramGB} GB (${hw.freeGB} GB livres) · GPU: ${hw.gpus.join(", ") || "nenhuma detectada"}`);
  if (!t?.chatModel) { log("nenhum modelo de chat ativo: ajuste pulado (configure em Configurações e reinicie, ou rode npm run tune)."); return null; }
  let version = "";
  try { version = String((await ollama(t.baseUrl, t.apiKey, "/api/version", undefined, 5_000)).version || ""); }
  catch { log(`Ollama indisponível em ${t.baseUrl}: ajuste adiado para a próxima inicialização (padrão do Ollama até lá).`); return null; }

  const manual = Number(process.env.OLLAMA_NUM_THREAD) > 0;
  const key = tuneKey(hw, t.baseUrl, version, t.chatModel), cached = readCache()[key];
  try {
    if (process.env.AUTOTUNE === "false") log("AUTOTUNE=false: medição desligada.");
    else if (manual) log(`OLLAMA_NUM_THREAD=${process.env.OLLAMA_NUM_THREAD} definido: usando o valor manual, sem medir.`);
    else if (cached && !opts.force) { current = cached; log(`usando ajuste salvo de ${cached.at.slice(0, 10)}: ${cached.numThread ? `${cached.numThread} threads` : "threads automáticas do Ollama"} (${cached.device}). Para medir de novo: npm run tune.`); }
    else { current = await sweep(t, hw, key, log); writeCache(current); log(`escolhido: ${current.numThread ? `${current.numThread} threads` : `threads automáticas (modelo na ${current.device === "gpu" ? "GPU" : "CPU"})`}.`); }
  } catch (e) { log(`medição falhou (${e instanceof Error ? e.message : e}); seguindo com o padrão do Ollama.`); }

  // Pré-carga com as opções reais das perguntas: embeddings primeiro e chat por último (a ordem de uso de cada pergunta).
  const threads = tunedThreads(t.baseUrl);
  try {
    if (t.embedding?.model) { const th = tunedThreads(t.embedding.baseUrl); await ollama(t.embedding.baseUrl, t.embedding.apiKey, "/api/embed", { model: t.embedding.model, input: ["aquecimento"], keep_alive: "30m", ...(th ? { options: { num_thread: th } } : {}) }, 120_000); }
    await ollama(t.baseUrl, t.apiKey, "/api/chat", { model: t.chatModel, stream: false, keep_alive: "30m", ...(isReasoningOnly(t.chatModel) ? {} : { think: false }), messages: [{ role: "user", content: "OK" }], options: { num_ctx: t.contextTokens, num_predict: 1, ...(threads ? { num_thread: threads } : {}) } });
    const models = await loaded(t.baseUrl, t.apiKey), chatModel = models.find(m => m.name === withTag(t.chatModel)), device = deviceOf(chatModel);
    log(`modelos prontos em ${((Date.now() - t0) / 1000).toFixed(1)} s · ${t.chatModel} na ${device === "gpu" ? "GPU" : device === "misto" ? "GPU+CPU" : "CPU"} · num_ctx ${t.contextTokens}${threads ? ` · ${threads} threads` : ""}`);
    if (device === "cpu" && isLocal(t.baseUrl) && hw.gpus.length) {
      const nvidia = hw.gpus.some(g => /nvidia/i.test(g));
      log(`DICA: este PC tem GPU (${hw.gpus.join(", ")}) mas o Ollama está usando só a CPU. ${nvidia ? "Instale/atualize o driver NVIDIA e reinicie o Ollama." : "Ative a aceleração Vulkan no Ollama (variável OLLAMA_VULKAN=1 e reinicie o Ollama)."} Em GPU integrada AMD (Radeon 680M) a resposta ficou 2–3× mais rápida nos testes.`);
    }
    if (t.embedding?.model && t.embedding.baseUrl === t.baseUrl && !models.some(m => m.name === withTag(t.embedding!.model)))
      log("DICA: o Ollama descarregou o modelo de embeddings ao carregar o de chat (OLLAMA_MAX_LOADED_MODELS=1?). Cada pergunta recarrega os dois (+2 a 7 s). Defina OLLAMA_MAX_LOADED_MODELS=2 e reinicie o Ollama.");
  } catch (e) { log(`pré-carga falhou (${e instanceof Error ? e.message : e}); os modelos carregam na 1ª pergunta.`); }
  return current;
}
