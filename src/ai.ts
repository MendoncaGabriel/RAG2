import { db } from "./database.js";

export type ChatProvider = "ollama" | "claude";
export type EmbeddingProvider = "ollama" | "voyage";
export interface AISettings {
  chatProvider: ChatProvider;
  embeddingProvider: EmbeddingProvider;
  ollama: { baseUrl: string; chatModel: string; embeddingModel: string };
  claude: { apiKey: string; model: string };
  voyage: { apiKey: string; model: string };
}

db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)");

const defaults: AISettings = {
  chatProvider: "ollama",
  embeddingProvider: "ollama",
  ollama: { baseUrl: "http://localhost:11434", chatModel: "qwen2.5:1.5b-instruct", embeddingModel: "bge-m3" },
  claude: { apiKey: "", model: "claude-haiku-5-5" },
  voyage: { apiKey: "", model: "voyage-3.5" },
};

export function getSettings(): AISettings {
  const row = db.prepare("SELECT value FROM settings WHERE key='ai'").get() as { value: string } | undefined;
  let saved: any = {};
  try { saved = row ? JSON.parse(row.value) : {}; } catch {}
  return {
    chatProvider: saved.chatProvider === "claude" ? "claude" : "ollama",
    embeddingProvider: saved.embeddingProvider === "voyage" ? "voyage" : "ollama",
    ollama: { ...defaults.ollama, ...saved.ollama },
    claude: { ...defaults.claude, ...saved.claude },
    voyage: { ...defaults.voyage, ...saved.voyage },
  };
}

const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() ? value.trim() : fallback);

// Chaves de API só são substituídas quando um novo valor é enviado.
export function saveSettings(input: any): AISettings {
  const current = getSettings();
  const next: AISettings = {
    chatProvider: input?.chatProvider === "claude" ? "claude" : "ollama",
    embeddingProvider: input?.embeddingProvider === "voyage" ? "voyage" : "ollama",
    ollama: {
      baseUrl: text(input?.ollama?.baseUrl, defaults.ollama.baseUrl).replace(/\/+$/, ""),
      chatModel: text(input?.ollama?.chatModel, defaults.ollama.chatModel),
      embeddingModel: text(input?.ollama?.embeddingModel, defaults.ollama.embeddingModel),
    },
    claude: { apiKey: text(input?.claude?.apiKey, current.claude.apiKey), model: text(input?.claude?.model, defaults.claude.model) },
    voyage: { apiKey: text(input?.voyage?.apiKey, current.voyage.apiKey), model: text(input?.voyage?.model, defaults.voyage.model) },
  };
  if (!/^https?:\/\//.test(next.ollama.baseUrl)) throw new Error("A URL do Ollama deve começar com http:// ou https://.");
  db.prepare("INSERT INTO settings(key,value) VALUES('ai',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));
  return next;
}

export function publicSettings() {
  const s = getSettings();
  return { ...s, claude: { model: s.claude.model, hasKey: !!s.claude.apiKey }, voyage: { model: s.voyage.model, hasKey: !!s.voyage.apiKey } };
}

async function request(label: string, url: string, init: RequestInit & { json?: unknown }) {
  const headers = { ...(init.json ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string>) };
  const res = await fetch(url, { method: init.method || (init.json ? "POST" : "GET"), headers, body: init.json ? JSON.stringify(init.json) : undefined, signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`${label} (${res.status}): ${(await res.text()).slice(0, 500)}`);
  return res.json() as Promise<any>;
}

const ollamaRequest = (path: string, json?: unknown) => request("Ollama", `${getSettings().ollama.baseUrl}${path}`, { json });

export interface ChatOptions { system: string; user: string; temperature?: number; topP?: number; maxTokens?: number; contextSize?: number; json?: boolean }

export async function chat(opts: ChatOptions): Promise<string> {
  const s = getSettings();
  if (s.chatProvider === "claude") {
    if (!s.claude.apiKey) throw new Error("Chave de API do Claude não configurada. Abra Configurações de IA.");
    const result = await request("Claude", "https://api.anthropic.com/v1/messages", {
      headers: { "x-api-key": s.claude.apiKey, "anthropic-version": "2023-06-01" },
      json: { model: s.claude.model, max_tokens: opts.maxTokens ?? 512, temperature: opts.temperature ?? 0, system: opts.system, messages: [{ role: "user", content: opts.user }] },
    });
    return String((result.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join(""));
  }
  const result = await ollamaRequest("/api/chat", {
    model: s.ollama.chatModel,
    stream: false,
    ...(opts.json ? { format: "json" } : {}),
    keep_alive: "5m",
    options: { temperature: opts.temperature ?? 0, top_p: opts.topP ?? 0.8, num_ctx: opts.contextSize ?? 4096, num_predict: opts.maxTokens ?? 512 },
    messages: [{ role: "system", content: opts.system }, { role: "user", content: opts.user }],
  });
  return String(result.message?.content || "");
}

export async function embedMany(inputs: string[]): Promise<number[][]> {
  const s = getSettings();
  if (s.embeddingProvider === "voyage") {
    if (!s.voyage.apiKey) throw new Error("Chave de API do Voyage AI não configurada. Abra Configurações de IA.");
    const result = await request("Voyage AI", "https://api.voyageai.com/v1/embeddings", { headers: { authorization: `Bearer ${s.voyage.apiKey}` }, json: { model: s.voyage.model, input: inputs } });
    const vectors = (result.data || []).sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding);
    if (vectors.length !== inputs.length) throw new Error(`Voyage AI retornou embeddings incompletos para ${s.voyage.model}.`);
    return vectors;
  }
  const result = await ollamaRequest("/api/embed", { model: s.ollama.embeddingModel, input: inputs });
  if (!Array.isArray(result.embeddings) || result.embeddings.length !== inputs.length) throw new Error(`Ollama retornou embeddings incompletos. Verifique se o modelo ${s.ollama.embeddingModel} foi baixado.`);
  return result.embeddings;
}

export interface AICheck { ok: boolean; detail: string }
// Verificação leve (sem custo) por padrão; "deep" executa uma chamada real de chat e de embedding.
export async function checkAI(deep = false): Promise<{ chat: AICheck; embedding: AICheck; ollamaModels: string[] }> {
  const s = getSettings();
  let ollamaModels: string[] = [];
  const run = async (fn: () => Promise<string>): Promise<AICheck> => { try { return { ok: true, detail: await fn() }; } catch (e) { return { ok: false, detail: e instanceof Error ? e.message : String(e) }; } };
  const usesOllama = s.chatProvider === "ollama" || s.embeddingProvider === "ollama";
  let ollamaCheck: AICheck | null = null;
  if (usesOllama) {
    ollamaCheck = await run(async () => { ollamaModels = ((await ollamaRequest("/api/tags")).models || []).map((m: any) => m.name); return `${ollamaModels.length} modelo(s) disponível(is)`; });
  }
  const chatCheck = s.chatProvider === "ollama"
    ? ollamaCheck!.ok && deep ? await run(async () => { await chat({ system: "Responda apenas OK.", user: "ping", maxTokens: 8, contextSize: 512 }); return `Modelo ${s.ollama.chatModel} respondeu`; }) : ollamaCheck!
    : !s.claude.apiKey ? { ok: false, detail: "Chave de API não configurada." }
    : deep ? await run(async () => { await chat({ system: "Responda apenas OK.", user: "ping", maxTokens: 8 }); return `Modelo ${s.claude.model} respondeu`; })
    : await run(async () => { await request("Claude", "https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": s.claude.apiKey, "anthropic-version": "2023-06-01" } }); return "Chave válida"; });
  const embeddingCheck = s.embeddingProvider === "ollama"
    ? ollamaCheck!.ok && deep ? await run(async () => { const [v] = await embedMany(["teste"]); return `Modelo ${s.ollama.embeddingModel} respondeu (${v.length} dimensões)`; }) : ollamaCheck!
    : !s.voyage.apiKey ? { ok: false, detail: "Chave de API não configurada." }
    : deep ? await run(async () => { const [v] = await embedMany(["teste"]); return `Modelo ${s.voyage.model} respondeu (${v.length} dimensões)`; })
    : { ok: true, detail: "Chave configurada" };
  return { chat: chatCheck, embedding: embeddingCheck, ollamaModels };
}
