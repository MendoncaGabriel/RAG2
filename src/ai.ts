import crypto from "node:crypto";
import { config } from "./config.js";
import { db } from "./database.js";
import { networkCause } from "./qdrant.js";
import { deriveProfile, embeddingPrefix, isReasoningOnly, sizeFromDetails, type ModelInfo } from "./modelprofile.js";
import { tunedThreads } from "./tuning.js";

// Camada única de IA: servidores Ollama cadastrados pelo usuário (tela de Configurações) e dois "slots" ativos,
// um para chat e outro para embeddings. Nada aqui depende de variáveis de ambiente.
export type ProviderKind = "ollama";
export const providerKinds: Record<ProviderKind, { label: string; baseUrl: string }> = {
  // No container, localhost é o próprio container: provedor novo nasce com o OLLAMA_BASE_URL (IP do Windows visto pelo WSL2).
  ollama: { label: "Ollama", get baseUrl() { return config.ollama.baseUrl || "http://localhost:11434"; } },
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
const toPublic = (p: Provider) => ({ id: p.id, name: p.name, kind: p.kind, kindLabel: providerKinds[p.kind].label, baseUrl: p.baseUrl, chatModel: p.chatModel, embeddingModel: p.embeddingModel, hasKey: !!p.apiKey, keyHint: p.apiKey ? `••••${p.apiKey.slice(-4)}` : "" });
export function listProviders() {
  const rows = db.prepare("SELECT * FROM ai_providers ORDER BY created_at, name").all().map(fromRow);
  return { providers: rows.map(toPublic), active: { chat: getProvider(getSetting("active_chat"))?.id || null, embedding: getProvider(getSetting("active_embedding"))?.id || null } };
}

const clean = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
function normalize(input: any, current?: Provider): Omit<Provider, "id"> {
  const kind = (input?.kind ?? current?.kind) as ProviderKind;
  if (!providerKinds[kind]) throw new Error("Tipo de provedor inválido.");
  const name = clean(input?.name, 80);
  if (!name) throw new Error("Nome obrigatório (até 80 caracteres).");
  const baseUrl = (clean(input?.baseUrl, 300) || providerKinds[kind].baseUrl).replace(/\/+$/, "");
  if (!/^https?:\/\/\S+$/.test(baseUrl)) throw new Error("A URL base deve começar com http:// ou https://.");
  // Chave em branco na edição mantém a atual; para remover use clearKey.
  const apiKey = input?.clearKey ? "" : clean(input?.apiKey, 500) || (current && current.kind === kind ? current.apiKey : "");
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

// O Ollama do ambiente (OLLAMA_BASE_URL, OLLAMA_LLM_MODEL, OLLAMA_EMBEDDING_MODEL: o Ollama do Windows 11) é sincronizado a cada
// inicialização num provedor fixo e ocupa os slots que estiverem vazios. Outros servidores podem ser cadastrados em Configurações.
export const ENV_PROVIDER_ID = "env-ollama";
{
  const o = config.ollama;
  if (o.baseUrl && (o.llmModel || o.embeddingModel)) {
    const data = normalize({ name: "Ollama (Windows)", kind: "ollama", baseUrl: o.baseUrl, apiKey: o.apiKey, clearKey: !o.apiKey, chatModel: o.llmModel, embeddingModel: o.embeddingModel });
    db.prepare("INSERT INTO ai_providers(id,name,kind,base_url,api_key,chat_model,embedding_model) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,api_key=excluded.api_key,chat_model=excluded.chat_model,embedding_model=excluded.embedding_model")
      .run(ENV_PROVIDER_ID, data.name, data.kind, data.baseUrl, data.apiKey, data.chatModel, data.embeddingModel);
    if (!activeProvider("chat") && data.chatModel) setActive({ chat: ENV_PROVIDER_ID });
    if (!activeProvider("embedding") && data.embeddingModel) setActive({ embedding: ENV_PROVIDER_ID });
  }
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
// Estado do Ollama do ambiente e dos modelos configurados (health check e inicialização).
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

// Threads do Ollama: medidas para este PC na inicialização (tuning.ts) ou OLLAMA_NUM_THREAD; sem valor, o Ollama decide.
// O mesmo valor em todas as chamadas: trocar num_thread entre chamadas faz o Ollama recarregar o modelo.
const threadOption = (p: Provider) => { const n = tunedThreads(p.baseUrl); return n ? { num_thread: n } : {}; };

// ---------- Chat ----------
export type Msg = { role: "system" | "user" | "assistant"; content: string };
export interface ChatOptions { messages: Msg[]; temperature?: number; topP?: number; topK?: number; maxTokens?: number; contextSize?: number; repeatPenalty?: number; json?: boolean; signal?: AbortSignal }

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
  await readLines(res, line => { const c = JSON.parse(line); if (c.error) throw new Error(`${label}: ${c.error}`); emit(String(c.message?.content || "")); });
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
export async function listModels(input: { kind: ProviderKind; baseUrl?: string; apiKey?: string }): Promise<string[]> {
  if (!providerKinds[input.kind]) throw new Error("Tipo de provedor inválido.");
  const base = (input.baseUrl || providerKinds[input.kind].baseUrl).replace(/\/+$/, ""), key = input.apiKey || "", label = providerKinds[input.kind].label;
  const data = await jsonOrThrow(label, await http(label, `${base}/api/tags`, { headers: key ? { authorization: `Bearer ${key}` } : {}, timeout: 15_000 }));
  return ((data.models || []) as any[]).map(m => String(m.name)).sort();
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
