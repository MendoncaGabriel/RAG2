// Inicialização do container: localiza o Ollama do host, baixa modelos ausentes e sobe o servidor.
const chatModel = process.env.OLLAMA_CHAT_MODEL || "qwen2.5:1.5b-instruct";
const embeddingModel = process.env.OLLAMA_EMBEDDING_MODEL || "bge-m3";
const log = (...args) => console.log("[docker]", ...args);

async function tags(base) {
  const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).models?.map(m => m.name) ?? [];
}

async function findOllama() {
  const configured = (process.env.OLLAMA_BASE_URL || "").replace(/\/$/, "");
  const candidates = [...new Set([
    configured,
    "http://host.docker.internal:11434", // Docker Desktop (Windows/Mac) e Linux com host-gateway
    "http://172.17.0.1:11434",           // gateway padrão da bridge do Docker no Linux
    "http://127.0.0.1:11434",            // modo network_mode: host
  ].filter(Boolean))];
  for (const base of candidates) {
    try { await tags(base); return base; } catch { /* tenta o próximo */ }
  }
  return null;
}

const has = (installed, model) => installed.some(name => name === model || name === `${model}:latest` || `${name}`.replace(/:latest$/, "") === model);

async function pullMissing(base) {
  let installed;
  try { installed = await tags(base); } catch { return; }
  for (const model of [...new Set([chatModel, embeddingModel])]) {
    if (has(installed, model)) continue;
    log(`Baixando modelo ${model} no Ollama (pode demorar)...`);
    try {
      const res = await fetch(`${base}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, stream: false }) });
      log(res.ok ? `Modelo ${model} pronto.` : `Falha ao baixar ${model}: HTTP ${res.status} ${await res.text()}`);
    } catch (error) {
      log(`Falha ao baixar ${model}:`, error instanceof Error ? error.message : String(error));
    }
  }
}

const base = await findOllama();
if (base) {
  process.env.OLLAMA_BASE_URL = base;
  log(`Ollama encontrado em ${base}`);
  if (process.env.OLLAMA_AUTO_PULL !== "false") void pullMissing(base);
} else {
  log("ATENÇÃO: Ollama não encontrado. Confirme que ele está em execução no host.");
  log("  Linux: use 'docker compose -f docker-compose.yml -f docker-compose.linux.yml up -d --build'");
  log("         ou inicie o Ollama com OLLAMA_HOST=0.0.0.0.");
  process.env.OLLAMA_BASE_URL = "http://host.docker.internal:11434";
}

await import("../dist/server.js");
