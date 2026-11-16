// Ajuste automático ao computador: roda na inicialização (em segundo plano, logo após abrir a porta) e serve para qualquer PC.
// 1) Detecta CPU (núcleos físicos/lógicos), RAM e GPU.
// 2) Mede no próprio PC, com o modelo de chat ativo, quantas threads deixam o Ollama mais rápido (leitura do prompt + geração)
//    e guarda o resultado em APP_DATA_DIR/tuning.json (chave: hardware + servidor + versão do Ollama + modelo). "npm run tune" mede de novo.
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
import { dataDir } from "./database.js";
import { isReasoningOnly } from "./modelprofile.js";
import { getAiTuning, type DeviceMode } from "./aisettings.js";

export interface Hardware { cpu: string; logical: number; physical: number; ramGB: number; freeGB: number; gpus: string[] }
export interface TuneTarget { baseUrl: string; apiKey?: string; chatModel: string; contextTokens: number; embedding?: { baseUrl: string; apiKey?: string; model: string } }
export type Sample = { threads: number; promptTps: number; evalTps: number; seconds: number };
export interface TuneResult { req?: DeviceMode; key: string; at: string; baseUrl: string; model: string; numThread?: number; device: "cpu" | "gpu" | "misto"; samples: Sample[] }

const exec = promisify(execFile);
const cacheFile = () => path.join(dataDir, "tuning.json");
let current: TuneResult | null = null;

// Threads usadas nas chamadas ao Ollama, conforme Configurações: manual (valor fixo) > automático (medido para este servidor) >
// "Ollama decide" (sem num_thread). Sem medição ainda, o Ollama decide.
export function tunedThreads(baseUrl: string): number | undefined {
  const t = getAiTuning();
  if (t.threadMode === "manual" && t.threads > 0) return t.threads;
  if (t.threadMode === "ollama") return undefined;
  return current && current.baseUrl === baseUrl && (current.req ?? "auto") === t.device ? current.numThread : undefined;
}
export const tuningSummary = () => current;
// Onde o chat roda, conforme Configurações. O mesmo valor em todas as chamadas (trocar num_gpu faz o Ollama recarregar o modelo).
// "cpu" = num_gpu 0 · "gpu" = todas as camadas na GPU (o Ollama precisa enxergar a GPU: em GPUs integradas, OLLAMA_IGPU_ENABLE=1) · "auto" = Ollama decide.
export const deviceOptions = (d: DeviceMode = getAiTuning().device): { num_gpu?: number } => d === "cpu" ? { num_gpu: 0 } : d === "gpu" ? { num_gpu: 999 } : {};
// Resultados medidos para este modelo/servidor/PC, um por dispositivo pedido (cpu, gpu, auto).
export function tuningResults(baseUrl: string, model: string): TuneResult[] {
  return Object.values(readCache()).filter(r => r.baseUrl === baseUrl && r.model === model && sameMachine(r.key));
}
const sameMachine = (key: string) => { try { const k = JSON.parse(key), cur = machineKey; return !!cur && k[1] === cur[1] && k[2] === cur[2] && k[3] === cur[3]; } catch { return false; } };
let machineKey: any[] | null = null;
// Andamento da medição (para a tela Configurações acompanhar): amostras já medidas e quantas faltam, no mínimo.
export interface TuneStatus { running: boolean; forced: boolean; device: DeviceMode; queue: DeviceMode[]; model: string; startedAt: string | null; planned: number; samples: Sample[]; error: string | null; finishedAt: string | null }
let status: TuneStatus = { running: false, forced: false, device: "auto" as DeviceMode, queue: [] as DeviceMode[], model: "", startedAt: null, planned: 0, samples: [], error: null, finishedAt: null };
export const tuningStatus = () => status;

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
// Candidatas da 1ª passada: 1, 2, 4 e passos de 2 até os núcleos físicos (sempre inclui o total). Em CPUs híbridas (P+E) o melhor valor costuma
// ser BAIXO (medido num i5-1235U: 2–3 threads deram o dobro da geração de 8); depois a melhor é refinada com os vizinhos (±1).
export function threadCandidates(physical: number): number[] {
  const p = Math.max(1, Math.floor(physical)), out = new Set<number>([1, 2, 4].filter(n => n <= p));
  for (let n = 6; n < p; n += 2) out.add(n);
  out.add(p);
  return [...out].sort((a, b) => a - b);
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
async function measure(t: TuneTarget, threads: number, req: DeviceMode): Promise<Sample> {
  const base = { model: t.chatModel, stream: false, keep_alive: "30m", ...(isReasoningOnly(t.chatModel) ? {} : { think: false }) };
  const options = { num_ctx: t.contextTokens, num_thread: threads, ...deviceOptions(req) };
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
// O 1º item é a versão do método de medição: mudar as candidatas/critério invalida os ajustes salvos.
export const tuneKey = (hw: Hardware, baseUrl: string, version: string, model: string, req: DeviceMode = "auto") => JSON.stringify([2, hw.cpu, hw.physical, hw.logical, Math.round(hw.ramGB), baseUrl, version, model, req]);

async function sweep(t: TuneTarget, hw: Hardware, key: string, log: (m: string) => void, full = false, req: DeviceMode = "auto", sameAs?: TuneResult): Promise<TuneResult> {
  const samples: Sample[] = status.samples = [];
  const at = new Date().toISOString(), done = (numThread: number | undefined, device: TuneResult["device"]) => ({ key, at, baseUrl: t.baseUrl, model: t.chatModel, numThread, device, samples });
  // Teste completo: de 1 thread até todas as threads lógicas do PC, sem pular nenhuma.
  const candidates = full ? Array.from({ length: Math.max(1, hw.logical) }, (_, i) => i + 1) : threadCandidates(hw.physical);
  status.planned = candidates.length;
  log(`medindo ${t.chatModel} (${req === "gpu" ? "GPU" : req === "cpu" ? "CPU" : "dispositivo automático"}) com ${candidates.join(", ")} threads (só na 1ª vez neste PC/modelo; leva de 1 a ${full ? 15 : 6} min)…`);
  const one = async (n: number) => { const s = await measure(t, n, req); samples.push(s); log(`  ${String(n).padStart(2)} threads: prompt ${s.promptTps} tok/s · geração ${s.evalTps} tok/s · resposta típica ≈ ${s.seconds} s`); };
  // Começa pelo total de núcleos: se o modelo ficou inteiro na GPU, as threads não importam e o resto da varredura é dispensado.
  await one(candidates[candidates.length - 1]);
  const device = deviceOf((await loaded(t.baseUrl, t.apiKey)).find(m => m.name === withTag(t.chatModel))) || "cpu";
  if (req === "gpu" && device === "cpu") throw new Error("O Ollama não usou a GPU. Em GPU integrada (Intel/AMD) ative OLLAMA_IGPU_ENABLE=1 (e OLLAMA_VULKAN=1) no serviço do Ollama e reinicie-o; confira com `ollama ps`.");
  // "Automático" que caiu na CPU é a mesma configuração do teste de CPU: reaproveita as medidas em vez de repetir minutos de teste.
  if (req === "auto" && device === "cpu" && sameAs) return { ...sameAs, req, key, at, samples: sameAs.samples };
  if (device === "gpu") return done(undefined, "gpu");
  for (const n of candidates.slice(0, -1)) await one(n);
  // Refina em volta da melhor (±1) quando o vizinho não foi medido.
  const best = pickThreads(samples)!;
  if (!full) for (const n of [best - 1, best + 1]) if (n >= 1 && n <= hw.physical && !samples.some(s => s.threads === n)) { status.planned++; await one(n); }
  return done(pickThreads(samples), device);
}

const isLocal = (url: string) => /^https?:\/\/(localhost|127\.|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal)/i.test(url);

// Uma medição por vez: chamadas simultâneas (inicialização, salvar ajustes, configuração automática, botão de teste) esperam a que já está rodando.
// Medições paralelas travavam o Ollama (fila de chat + embeddings sem resposta, indexação sem andar).
let tuning: Promise<TuneResult | null> | null = null;
export function autoTune(t: TuneTarget | null, opts: { force?: boolean; full?: boolean; devices?: DeviceMode[]; log?: (m: string) => void } = {}): Promise<TuneResult | null> {
  if (tuning) return tuning;
  status = { running: true, forced: !!opts.force || !!opts.full, device: opts.devices?.[0] ?? getAiTuning().device, queue: opts.devices?.length ? opts.devices : [getAiTuning().device], model: t?.chatModel || "", startedAt: new Date().toISOString(), planned: 0, samples: [], error: null, finishedAt: null };
  return tuning = autoTuneNow(t, opts)
    .catch(e => { status.error = e instanceof Error ? e.message : String(e); throw e; })
    .finally(() => { status.running = false; status.finishedAt = new Date().toISOString(); tuning = null; });
}
async function autoTuneNow(t: TuneTarget | null, opts: { force?: boolean; full?: boolean; devices?: DeviceMode[]; log?: (m: string) => void } = {}): Promise<TuneResult | null> {
  const log = opts.log || ((m: string) => console.info(`[Ajuste] ${m}`));
  const t0 = Date.now();
  const hw = await detectHardware();
  log(`${hw.cpu} · ${hw.physical} núcleos físicos / ${hw.logical} lógicos · RAM ${hw.ramGB} GB (${hw.freeGB} GB livres) · GPU: ${hw.gpus.join(", ") || "nenhuma detectada"}`);
  if (!t?.chatModel) { log("nenhum modelo de chat ativo: ajuste pulado (escolha uma IA em Configurações)."); return null; }
  let version = "";
  try { version = String((await ollama(t.baseUrl, t.apiKey, "/api/version", undefined, 5_000)).version || ""); }
  catch { log(`Ollama indisponível em ${t.baseUrl}: ajuste adiado para a próxima inicialização (padrão do Ollama até lá).`); return null; }

  const mode = getAiTuning().threadMode, inUse = getAiTuning().device;
  machineKey = JSON.parse(tuneKey(hw, t.baseUrl, version, t.chatModel));
  const devices = opts.devices?.length ? opts.devices : [inUse];
  const doneNow: Partial<Record<DeviceMode, TuneResult>> = {};
  for (const req of devices) {
    status.device = req;
    const key = tuneKey(hw, t.baseUrl, version, t.chatModel, req), cached = readCache()[key], label = req === "gpu" ? "GPU" : req === "cpu" ? "CPU" : "automático";
    try {
      if (mode === "ollama" && !opts.force) log("threads: o Ollama decide (Configurações); medição desligada.");
      else if (mode === "manual" && !opts.force) log(`threads: ${getAiTuning().threads} (manual, Configurações); sem medir.`);
      else if (cached && !opts.force && !opts.full) { if (req === inUse) current = cached; log(`usando ajuste salvo de ${cached.at.slice(0, 10)} (${label}): ${cached.numThread ? `${cached.numThread} threads` : "threads automáticas do Ollama"} (${cached.device}). Para medir de novo use "Testar desempenho" em Configurações.`); }
      else {
        const res = await sweep(t, hw, key, log, opts.full, req, doneNow.cpu);
        doneNow[req] = res;
        writeCache(res);
        if (req === inUse) current = res;
        log(`escolhido (${label}): ${res.numThread ? `${res.numThread} threads` : `threads automáticas (modelo na ${res.device === "gpu" ? "GPU" : "CPU"})`}`);
      }
    } catch (e) { status.error = e instanceof Error ? e.message : String(e); log(`medição ${label} falhou (${status.error}); seguindo com o padrão do Ollama.`); }
  }

  // Pré-carga com as opções reais das perguntas: embeddings primeiro e chat por último (a ordem de uso de cada pergunta).
  const threads = tunedThreads(t.baseUrl);
  try {
    if (t.embedding?.model) { const th = tunedThreads(t.embedding.baseUrl); await ollama(t.embedding.baseUrl, t.embedding.apiKey, "/api/embed", { model: t.embedding.model, input: ["aquecimento"], keep_alive: "30m", options: { ...(th ? { num_thread: th } : {}), ...deviceOptions() } }, 120_000); }
    await ollama(t.baseUrl, t.apiKey, "/api/chat", { model: t.chatModel, stream: false, keep_alive: "30m", ...(isReasoningOnly(t.chatModel) ? {} : { think: false }), messages: [{ role: "user", content: "OK" }], options: { num_ctx: t.contextTokens, num_predict: 1, ...(threads ? { num_thread: threads } : {}), ...deviceOptions() } });
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
