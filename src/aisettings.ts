import { db } from "./database.js";

// Ajustes finos da IA, editados em Configurações (nada vem do .env). Cada número 0 = automático: o valor é derivado do modelo
// ativo (modelprofile.ts) ou, nas threads, medido neste PC (tuning.ts). Valor > 0 = manual, vale para qualquer modelo.
export type ThreadMode = "auto" | "manual" | "ollama";
export interface AiTuning {
  contextTokens: number; // num_ctx do Ollama (0 = perfil do modelo; nunca passa do contexto nativo do modelo)
  maxTokens: number;     // teto de tokens da resposta, antes do ajuste Rápido/Detalhado (0 = perfil)
  contextChars: number;  // caracteres de documentos que entram no prompt (0 = perfil)
  topK: number;          // trechos recuperados por pergunta (0 = perfil)
  threadMode: ThreadMode; // auto = medido neste PC · manual = `threads` · ollama = o Ollama decide
  threads: number;
}
export const defaultTuning = (): AiTuning => ({ contextTokens: 0, maxTokens: 0, contextChars: 0, topK: 0, threadMode: "auto", threads: 0 });
// Limites aceitos (0 sempre vale: automático).
export const tuningLimits = { contextTokens: [2048, 1_048_576], maxTokens: [128, 32_768], contextChars: [2_000, 400_000], topK: [1, 12], threads: [1, 256] } as const;

db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
const KEY = "ai_tuning";
let cache: AiTuning | null = null;

function sanitize(input: any, base: AiTuning): AiTuning {
  const out = { ...base };
  for (const field of ["contextTokens", "maxTokens", "contextChars", "topK", "threads"] as const) {
    if (input?.[field] === undefined || input[field] === null || input[field] === "") continue;
    const v = Math.round(Number(input[field])), [min, max] = tuningLimits[field];
    if (!Number.isFinite(v) || v < 0) throw new Error(`Valor inválido para ${field}.`);
    if (v !== 0 && (v < min || v > max)) throw new Error(`${labels[field]}: use um valor entre ${min} e ${max}, ou Automático.`);
    out[field] = v;
  }
  if (input?.threadMode !== undefined) {
    if (!["auto", "manual", "ollama"].includes(input.threadMode)) throw new Error("Modo de threads inválido.");
    out.threadMode = input.threadMode;
  }
  if (out.threadMode === "manual" && !out.threads) throw new Error("Informe o número de threads ou escolha Automático.");
  return out;
}
const labels = { contextTokens: "Contexto", maxTokens: "Tamanho da resposta", contextChars: "Texto dos documentos", topK: "Trechos por pergunta", threads: "Threads" };

export function getAiTuning(): AiTuning {
  if (cache) return cache;
  let saved: any = null;
  try { const row = db.prepare("SELECT value FROM settings WHERE key=?").get(KEY) as { value: string } | undefined; saved = row ? JSON.parse(row.value) : null; } catch { /* valor corrompido: volta ao automático */ }
  try { cache = sanitize(saved, defaultTuning()); } catch { cache = defaultTuning(); }
  return cache;
}
export function setAiTuning(input: unknown): AiTuning {
  const next = sanitize(input, getAiTuning());
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(KEY, JSON.stringify(next));
  return (cache = next);
}
// Valor manual (> 0) ou undefined, para "manual || perfil".
export const manual = (field: "contextTokens" | "maxTokens" | "contextChars" | "topK") => getAiTuning()[field] || undefined;
