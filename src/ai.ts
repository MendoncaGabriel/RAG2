import crypto from "node:crypto";
import fs from "node:fs";
import { db } from "./database.js";
import { networkCause } from "./qdrant.js";
import { deriveProfile, embeddingPrefix, isReasoningOnly, sizeFromDetails, type ModelInfo } from "./modelprofile.js";
import { tunedThreads } from "./tuning.js";

// Camada única de IA: servidores Ollama cadastrados pelo usuário (tela de Configurações, ou detecção automática) e dois "slots" ativos,
// um para chat e outro para embeddings. Nada aqui depende de variáveis de ambiente.
export type ProviderKind = "ollama";
const providerKinds: Record<ProviderKind, { label: string; baseUrl: string }> = {
  // No container, localhost é o próprio container: o botão "Detectar" de Configurações procura o endereço certo (detectOllama).
  ollama: { label: "Ollama", baseUrl: "http://localhost:11434" },
};

export interface Provider { id: string; name: string; kind: ProviderKind; baseUrl: string; apiKey: string; chatModel: string; embeddingModel: string }
export type Slot = "chat" | "embedding";

db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
db.exec("CREATE TABLE IF NOT EXISTS ai_providers(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '', chat_model TEXT NOT NULL DEFAULT '', embedding_model TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')))");
// Versões anteriores aceitavam OpenAI, Gemini e Anthropic: esses cadastros são removidos, e os slots que os usavam ficam vazios.
db.exec("DELETE FROM ai_providers WHERE kind<>'ollama'");
db.exec("UPDATE settings SET value='' WHERE key IN ('active_chat','active_embedding') AND value NOT IN (SELECT id FROM ai_providers)");

const fromRow = (r: any): Provider => ({ id: r.id, name: r.name, kind: r.kind, baseUrl: r.base_url, apiKey: r.api_key, chatModel: r.chat_model, embeddingModel: r.embedding_model });
export const getProvider = (id: string | null | undefined) => { const r = id ? db.prepare("SELECT * FROM ai_providers WHERE id=?").get(id) : undefined; return r ? fromRow(r) : null; };
const getSetting = (key: string) => (db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value || "";
const setSetting = (key: string, value: string) => { db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); };

// A chave nunca sai do servidor: o cliente só recebe se existe e os últimos caracteres.
const toPublic = (p: Provider) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, chatModel: p.chatModel, embeddingModel: p.embeddingModel, hasKey: !!p.apiKey, keyHint: p.apiKey ? `••••${p.apiKey.slice(-4)}` : "" });
export function listProviders() {
  const rows = db.prepare("SELECT * FROM ai_providers ORDER BY created_at, name").all().map(fromRow);
  return { providers: rows.map(toPublic), active: { chat: getProvider(getSetting("active_chat"))?.id || null, embedding: getProvider(getSetting("active_embedding"))?.id || null } };
}

const clean = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
function normalize(input: any, current?: Provider): Omit<Provider, "id"> {
  // O sistema só usa Ollama: o tipo não é escolhido pelo usuário.
  const kind: ProviderKind = "ollama";
  const baseUrl = (clean(input?.baseUrl, 300) || current?.baseUrl || providerKinds[kind].baseUrl).replace(/\/+$/, "");
  if (!/^https?:\/\/\S+$/.test(baseUrl)) throw new Error("O endereço do servidor deve começar com http:// ou https:// (ex.: http://172.29.48.1:11434).");
  // Nome opcional na tela: sem ele, usa o endereço do servidor.
  const name = clean(input?.name, 80) || current?.name || ("Ollama (" + new URL(baseUrl).host + ")");
  // Chave em branco na edição mantém a atual; para remover use clearKey.
  const apiKey = input?.clearKey ? "" : clean(input?.apiKey, 500) || (current?.apiKey || "");
  const chatModel = clean(input?.chatModel, 200), embeddingModel = clean(input?.embeddingModel, 200);
  if (!chatModel && !embeddingModel) throw new Error("Informe ao menos um modelo (chat ou embeddings).");
  return { name, kind, baseUrl, apiKey, chatModel, embeddingModel };
}
export function createProvider(input: any) {
  const data = normalize(input), id = crypto.randomUUID();
  db.prepare("INSERT INTO ai_providers(id,name,kind,base_url,api_key,chat_model,embedding_model) VALUES(?,?,?,?,?,?,?)").run(id, data.name, data.kind, data.baseUrl, data.apiKey, data.chatModel, data.embeddingModel);
  return toPublic({ id, ...data });
}
export function updateProvider(id: string, input: any) {
  const current = getProvider(id);
  if (!current) return null;
  const data = normalize(input, current);
  db.prepare("UPDATE ai_providers SET name=?,kind=?,base_url=?,api_key=?,chat_model=?,embedding_model=? WHERE id=?").run(data.name, data.kind, data.baseUrl, data.apiKey, data.chatModel, data.embeddingModel, id);
  // Se o modelo usado por um slot foi removido da edição, o slot deixa de apontar para este provedor.
  if (!data.chatModel && getSetting("active_chat") === id) setSetting("active_chat", "");
  if (!data.embeddingModel && getSetting("active_embedding") === id) setSetting("active_embedding", "");
  return toPublic({ id, ...data });
}
export function deleteProvider(id: string) {
  const changes = db.prepare("DELETE FROM ai_providers WHERE id=?").run(id).changes;
  if (getSetting("active_chat") === id) setSetting("active_chat", "");
  if (getSetting("active_embedding") === id) setSetting("active_embedding", "");
  return changes > 0;
}
export function setActive(input: { chat?: string | null; embedding?: string | null }) {
  for (const [slot, value] of [["chat", input.chat], ["embedding", input.embedding]] as const) {
    if (value === undefined) continue;
    if (value) {
      const p = getProvider(value);
      if (!p) throw new Error("Provedor não encontrado.");
      if (slot === "chat" && !p.chatModel) throw new Error(`"${p.name}" não tem modelo de chat cadastrado.`);
      if (slot === "embedding" && !p.embeddingModel) throw new Error(`"${p.name}" não tem modelo de embeddings cadastrado.`);
    }
    setSetting(`active_${slot}`, value || "");
  }
}
export function activeProvider(slot: Slot): Provider | null {
  const p = getProvider(getSetting(`active_${slot}`));
  return p && (slot === "chat" ? p.chatModel : p.embeddingModel) ? p : null;
}
export function activeSummary() {
  const one = (slot: Slot) => { const p = activeProvider(slot); return p ? { id: p.id, name: p.name, kind: p.kind, model: slot === "chat" ? p.chatModel : p.embeddingModel } : null; };
  return { chat: one("chat"), embedding: one("embedding") };
}

// ---------- Detecção automática do servidor ----------
// Dentro do container, localhost é o próprio container: o Ollama do Windows aparece pelo IP do Windows visto pelo WSL2 (DNS repassado
// pelo WSL e gateway), pela ponte de scripts/windows/ollama-wsl-bridge.ps1. Só endereços locais são testados, nunca um destino informado.
const readText = (file: string) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };
export function candidateUrls(): string[] {
  const hosts = new Set<string>(["localhost", "host.docker.internal"]);
  for (const m of readText("/etc/resolv.conf").matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g)) hosts.add(m[1]);
  for (const line of readText("/proc/net/route").split("\n").slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c[1] === "00000000" && c[2]) { const n = parseInt(c[2], 16); hosts.add([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join(".")); }
  }
  return [...hosts].filter(h => !/^127\.|^0\./.test(h)).map(h => `http://${h}:11434`);
}
// O Windows (host do WSL2 em modo NAT) é o gateway .1 da sub-rede /20 do WSL, sempre dentro de 172.16.0.0/12. De dentro do container esse IP
// não aparece em arquivo nenhum (o resolv.conf traz só o DNS do WSL e o gateway é a rede do Docker), então, se nada responder nos endereços
// conhecidos, a detecção testa os 256 gateways possíveis, só na porta do Ollama e só quando o usuário pede a detecção.
export function wslGatewayCandidates(): string[] {
  const urls: string[] = [];
  for (let b = 16; b <= 31; b++) for (let c = 0; c < 256; c += 16) urls.push(`http://172.${b}.${c}.1:11434`);
  return urls;
}
async function probe(baseUrl: string, timeout: number): Promise<{ baseUrl: string; models: string[] } | null> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return Array.isArray(data?.models) ? { baseUrl, models: data.models.map((m: any) => String(m.name)).sort() } : null;
  } catch { return null; }
}
export async function detectOllama(): Promise<{ baseUrl: string; models: string[] }[]> {
  const known = [...new Set(candidateUrls())];
  const hit = (await Promise.all(known.map(u => probe(u, 2_500)))).filter((f): f is { baseUrl: string; models: string[] } => !!f);
  if (hit.length) return hit;
  return (await Promise.all(wslGatewayCandidates().filter(u => !known.includes(u)).map(u => probe(u, 1_500)))).filter((f): f is { baseUrl: string; models: string[] } => !!f);
}
const isEmbeddingName = (n: string) => /embed|bge|e5-|minilm|gte-|arctic|mxbai|nomic|jina|bert/i.test(n);
const rank = (n: string, prefs: RegExp[]) => { const i = prefs.findIndex(r => r.test(n)); return i < 0 ? prefs.length : i; };
// Escolha padrão entre os modelos instalados: o que responde (família conhecida primeiro) e o de embeddings (bge-m3 primeiro).
export function pickModels(models: string[]) {
  const by = (list: string[], prefs: RegExp[]) => [...list].sort((x, y) => rank(x, prefs) - rank(y, prefs) || x.localeCompare(y))[0] || "";
  return { chat: by(models.filter(m => !isEmbeddingName(m)), [/qwen3\.5/i, /qwen3/i, /qwen2\.5/i, /llama3/i, /gemma/i, /phi/i, /mistral/i]), embedding: by(models.filter(isEmbeddingName), [/bge-m3/i, /nomic/i, /mxbai/i, /embeddinggemma/i]) };
}
// Um clique: acha o Ollama, escolhe modelos instalados, cadastra e põe em uso o que ainda estiver sem escolha (não troca o que o usuário já usa).
export async function autoConfigure() {
  const found = await detectOllama();
  if (!found.length) throw new Error(`Nenhum Ollama encontrado automaticamente (testei este computador, o DNS e o gateway do WSL2 e os gateways 172.16–31.x). ${bridgeHint} Se o servidor estiver em outro endereço, cadastre-o manualmente.`);
  const server = found.find(f => f.models.length) ?? found[0], picked = pickModels(server.models);
  if (!picked.chat && !picked.embedding) throw new Error(`O Ollama em ${server.baseUrl} não tem modelos instalados. No Windows, execute "ollama pull qwen3:1.7b" e "ollama pull bge-m3", ou cadastre outro modelo manualmente.`);
  const existing = listProviders().providers.find(p => p.baseUrl === server.baseUrl);
  const saved = existing
    ? updateProvider(existing.id, { name: existing.name, baseUrl: existing.baseUrl, chatModel: existing.chatModel || picked.chat, embeddingModel: existing.embeddingModel || picked.embedding })!
    : createProvider({ name: "Ollama (detectado)", baseUrl: server.baseUrl, chatModel: picked.chat, embeddingModel: picked.embedding });
  const activated: Slot[] = [];
  if (!activeProvider("chat") && saved.chatModel) { setActive({ chat: saved.id }); activated.push("chat"); }
  if (!activeProvider("embedding") && saved.embeddingModel) { setActive({ embedding: saved.id }); activated.push("embedding"); }
  return { provider: saved, baseUrl: server.baseUrl, chatModel: saved.chatModel, embeddingModel: saved.embeddingModel, activated, models: server.models.length };
}

// ---------- HTTP ----------
const bridgeHint = "Confira se o Ollama está aberto no Windows e se a ponte WSL2 está ativa (scripts/windows/ollama-wsl-bridge.ps1; o IP do Windows muda se o WSL trocar de sub-rede).";
async function http(label: string, url: string, init: { headers?: Record<string, string>; json?: unknown; timeout?: number; signal?: AbortSignal }) {
  const res = await fetch(url, { method: init.json === undefined ? "GET" : "POST", headers: { ...(init.json === undefined ? {} : { "content-type": "application/json" }), ...init.headers }, body: init.json === undefined ? undefined : JSON.stringify(init.json), signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(init.timeout ?? 180_000)]) : AbortSignal.timeout(init.timeout ?? 180_000) }).catch(e => { if (init.signal?.aborted) throw e; throw new Error(`${label}: não foi possível conectar a ${new URL(url).origin} (${networkCause(e)}). ${bridgeHint}`); });
  return res;
}

// ---------- Verificação do servidor e dos modelos (antes de qualquer inferência) ----------
// Lista de modelos instalados por servidor, em cache curto. Modelo ausente vira mensagem clara; nada é baixado automaticamente.
const tagsCache = new Map<string, { at: number; models?: Set<string>; error?: string }>();
const withTag = (m: string) => (m.includes(":") ? m : `${m}:latest`);
async function installedModels(p: Provider, force = false): Promise<Set<string>> {
  const hit = tagsCache.get(p.baseUrl);
  if (!force && hit && Date.now() - hit.at < (hit.models ? 60_000 : 5_000)) { if (hit.models) return hit.models; throw new Error(hit.error); }
  try {
    const data = await jsonOrThrow("Ollama", await http("Ollama", `${p.baseUrl}/api/tags`, { headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}, timeout: 8_000 }));
    const models = new Set<string>(((data.models || []) as any[]).map(m => withTag(String(m.name))));
    tagsCache.set(p.baseUrl, { at: Date.now(), models });
    return models;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    tagsCache.set(p.baseUrl, { at: Date.now(), error });
    throw new Error(error);
  }
}
export async function ensureModel(p: Provider, model: string) {
  if ((await installedModels(p)).has(withTag(model))) return;
  if ((await installedModels(p, true)).has(withTag(model))) return;
  throw new Error(`O modelo "${model}" não está disponível no Ollama em ${p.baseUrl}. No Windows, execute "ollama pull ${model}" ou escolha outro modelo.`);
}
// Estado do Ollama em uso e dos modelos escolhidos (health check e inicialização).
export async function ollamaStatus(): Promise<{ ok: boolean; baseUrl?: string; models?: string[]; error?: string }> {
  const p = activeProvider("chat") ?? activeProvider("embedding");
  if (!p) return { ok: false, error: "Nenhum servidor Ollama configurado." };
  try {
    const models = await installedModels(p, true);
    const need = [activeProvider("chat")?.chatModel, activeProvider("embedding")?.embeddingModel].filter((m): m is string => !!m);
    const missing = need.filter(m => !models.has(withTag(m)));
    return { ok: !missing.length, baseUrl: p.baseUrl, models: need, ...(missing.length ? { error: `Modelos ausentes no Ollama: ${missing.join(", ")} (no Windows: ollama pull <modelo>).` } : {}) };
  } catch (e) { return { ok: false, baseUrl: p.baseUrl, error: e instanceof Error ? e.message : String(e) }; }
}
// Erro HTTP legível; modelo ausente vira instrução de como baixar ou trocar.
async function httpError(label: string, res: Response, model?: string) {
  const text = (await res.text()).slice(0, 500);
  if (label === "Ollama" && res.status === 404 && /not found/i.test(text) && model) return new Error(`O modelo "${model}" não está instalado no Ollama. Baixe com "ollama pull ${model}" ou escolha outro modelo em Configurações (use "Buscar modelos" para ver os instalados).`);
  return new Error(`${label} (${res.status}): ${text}`);
}
async function jsonOrThrow(label: string, res: Response, model?: string) {
  if (!res.ok) throw await httpError(label, res, model);
  return res.json() as Promise<any>;
}
// Lê NDJSON (formato de streaming do Ollama) linha a linha.
async function readLines(res: Response, handle: (payload: string) => void) {
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (line: string) => { const t = line.trim(); if (t) handle(t); };
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(part, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    lines.forEach(flush);
  }
  flush(buffer);
}

// ---------- Metadados do modelo (Ollama /api/show) ----------
// O perfil de uso (rag.ts) é derivado do modelo ativo: tamanho, contexto nativo e capacidades reais quando o Ollama informa; senão, do nome.
const infoCache = new Map<string, { at: number; info: ModelInfo | null }>();
const infoKey = (p: Provider) => `${p.baseUrl}|${p.chatModel}`;
export const cachedModelInfo = (p: Provider | null): ModelInfo | undefined => (p ? infoCache.get(infoKey(p))?.info ?? undefined : undefined);
export async function refreshModelInfo(p: Provider | null): Promise<ModelInfo | undefined> {
  if (!p?.chatModel) return undefined;
  const hit = infoCache.get(infoKey(p));
  if (hit && Date.now() - hit.at < (hit.info ? 600_000 : 60_000)) return hit.info ?? undefined;
  let info: ModelInfo | null = null;
  try {
    const res = await http("Ollama", `${p.baseUrl}/api/show`, { headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}, timeout: 8_000, json: { model: p.chatModel, name: p.chatModel } });
    if (res.ok) {
      const d = await res.json() as any, mi = d.model_info || {};
      const ctxKey = Object.keys(mi).find(k => k.endsWith(".context_length")), count = Number(mi["general.parameter_count"]);
      const details = String(d.details?.parameter_size || "");
      info = { family: d.details?.family, quantization: d.details?.quantization_level, capabilities: Array.isArray(d.capabilities) ? d.capabilities : undefined,
        contextLength: ctxKey ? Number(mi[ctxKey]) || undefined : undefined,
        parameterSize: Number.isFinite(count) && count > 0 ? count / 1e9 : sizeFromDetails(details) };
    }
  } catch { /* sem metadados: o perfil usa o nome do modelo */ }
  infoCache.set(infoKey(p), { at: Date.now(), info });
  return info ?? undefined;
}

// Threads do Ollama: conforme Configurações: medidas para este PC (tuning.ts), valor manual ou o Ollama decide.
// O mesmo valor em todas as chamadas: trocar num_thread entre chamadas faz o Ollama recarregar o modelo.
const threadOption = (p: Provider) => { const n = tunedThreads(p.baseUrl); return n ? { num_thread: n } : {}; };

// ---------- Chat ----------
export type Msg = { role: "system" | "user" | "assistant"; content: string };
// onStats: tokens que o Ollama informa no fim (prompt_eval_count/eval_count). Com o início do prompt em cache, prompt_eval_count conta
// só a parte processada nesta chamada.
export interface ChatOptions { messages: Msg[]; temperature?: number; topP?: number; topK?: number; maxTokens?: number; contextSize?: number; repeatPenalty?: number; json?: boolean; signal?: AbortSignal; onStats?: (s: { promptTokens: number; outputTokens: number }) => void }

export async function chatWith(p: Provider, opts: ChatOptions, onToken?: (token: string) => void): Promise<string> {
  let full = "";
  const emit = (token: string) => { if (token) { full += token; onToken?.(token); } };
  // Modelos que só funcionam raciocinando não aceitam desligar o "pensar": o parâmetro é omitido e a saída ganha folga para o raciocínio.
  const reasoningOnly = isReasoningOnly(p.chatModel);
  const maxTokens = (opts.maxTokens ?? 512) + (reasoningOnly ? 2048 : 0);
  const label = providerKinds[p.kind].label;
  await ensureModel(p, p.chatModel);
  const res = await http(label, `${p.baseUrl}/api/chat`, { headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}, timeout: 600_000, signal: opts.signal, json: {
    model: p.chatModel, stream: true, ...(reasoningOnly ? {} : { think: false }), keep_alive: "30m", ...(opts.json ? { format: "json" } : {}),
    options: { temperature: opts.temperature ?? 0.1, top_p: opts.topP ?? 0.8, ...(opts.topK ? { top_k: opts.topK } : {}), repeat_penalty: opts.repeatPenalty ?? 1.1, num_ctx: opts.contextSize ?? 4096, num_predict: maxTokens, ...threadOption(p) },
    messages: opts.messages,
  } });
  if (!res.ok || !res.body) throw await httpError(label, res, p.chatModel);
  await readLines(res, line => {
    const c = JSON.parse(line); if (c.error) throw new Error(`${label}: ${c.error}`);
    emit(String(c.message?.content || ""));
    if (c.done) opts.onStats?.({ promptTokens: Number(c.prompt_eval_count) || 0, outputTokens: Number(c.eval_count) || 0 });
  });
  return full;
}
export async function chat(opts: ChatOptions, onToken?: (token: string) => void) {
  const p = activeProvider("chat");
  if (!p) throw new Error("Nenhuma IA de chat selecionada. Abra Configurações, cadastre um servidor Ollama e escolha-o para o chat.");
  return chatWith(p, opts, onToken);
}

// ---------- Embeddings ----------
export async function embedWith(p: Provider, inputs: string[], kind: "query" | "document" = "document"): Promise<number[][]> {
  const label = providerKinds[p.kind].label, model = p.embeddingModel;
  await ensureModel(p, model);
  const data = await jsonOrThrow(label, await http(label, `${p.baseUrl}/api/embed`, { headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}, json: { model, input: inputs.map(t => embeddingPrefix(model, kind) + t), keep_alive: "30m", ...(tunedThreads(p.baseUrl) ? { options: threadOption(p) } : {}) } }), model);
  const vectors: number[][] = data.embeddings;
  if (!Array.isArray(vectors) || vectors.length !== inputs.length || vectors.some(v => !Array.isArray(v))) throw new Error(`${p.name} retornou embeddings incompletos para ${model}. Verifique se o modelo existe.`);
  return vectors;
}
export async function embedMany(inputs: string[], kind: "query" | "document" = "document") {
  const p = activeProvider("embedding");
  if (!p) throw new Error("Nenhuma IA de embeddings selecionada. Abra Configurações, cadastre um servidor Ollama e escolha-o para embeddings.");
  return embedWith(p, inputs, kind);
}

// ---------- Descoberta de modelos e teste ----------
// Modelos instalados no servidor informado (com a chave informada). Sem endereço, procura o Ollama sozinho (detectOllama). Devolve também
// a divisão entre modelos de chat e de embeddings e a sugestão padrão, para a tela oferecer a escolha certa em cada cadastro.
export async function listModels(input: { baseUrl?: string; apiKey?: string }) {
  let base = (input.baseUrl || "").trim().replace(/\/+$/, ""), models: string[];
  if (!base) {
    const found = (await detectOllama())[0];
    if (!found) throw new Error("Nenhum Ollama encontrado automaticamente. Digite o endereço do servidor. " + bridgeHint);
    base = found.baseUrl; models = found.models;
  } else {
    if (!/^https?:\/\/\S+$/.test(base)) throw new Error("O endereço do servidor deve começar com http:// ou https://.");
    const data = await jsonOrThrow("Ollama", await http("Ollama", base + "/api/tags", { headers: input.apiKey ? { authorization: "Bearer " + input.apiKey } : {}, timeout: 15_000 }));
    models = ((data.models || []) as any[]).map(m => String(m.name)).sort();
  }
  return { baseUrl: base, models, chat: models.filter(m => !isEmbeddingName(m)), embedding: models.filter(isEmbeddingName), suggested: pickModels(models) };
}
// Faz uma chamada real e mínima para cada modelo cadastrado.
export async function testProvider(p: Provider) {
  const run = async (fn: () => Promise<string>) => { const t = Date.now(); try { return { ok: true, detail: `${await fn()} · ${Date.now() - t} ms` }; } catch (e) { return { ok: false, detail: e instanceof Error ? e.message : String(e) }; } };
  return {
    // num_ctx igual ao das perguntas: com outro valor o Ollama recarregaria o modelo na pergunta seguinte.
    chat: p.chatModel ? await run(async () => { const info = await refreshModelInfo(p), prof = deriveProfile(p.chatModel, info); await chatWith(p, { messages: [{ role: "user", content: "Responda apenas OK." }], maxTokens: 16, contextSize: prof.contextTokens }); return `Chat (${p.chatModel}) respondeu · perfil ${prof.tier} (${prof.family}, ${Number(prof.sizeB.toFixed(1))}B por ${prof.sizeSource}, contexto ${prof.contextTokens})`; }) : null,
    embedding: p.embeddingModel ? await run(async () => { const [v] = await embedWith(p, ["teste"]); return `Embeddings (${p.embeddingModel}) responderam com ${v.length} dimensões`; }) : null,
  };
}
