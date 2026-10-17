import crypto from "node:crypto";
import { db } from "./database.js";

const base = (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
export async function ollama(path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`Ollama (${res.status}): ${await res.text()}`);
  return res.json() as Promise<any>;
}
export async function embed(input: string): Promise<number[]> {
  const model = process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text";
  const result = await ollama("/api/embed", { model, input });
  const vector = result.embeddings?.[0];
  if (!Array.isArray(vector)) throw new Error(`Ollama não retornou embedding. Verifique se o modelo ${model} foi baixado.`);
  return vector;
}
export async function embedMany(inputs: string[]): Promise<number[][]> {
  const model = process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text";
  const result = await ollama("/api/embed", { model, input: inputs });
  if (!Array.isArray(result.embeddings) || result.embeddings.length !== inputs.length) throw new Error(`Ollama retornou embeddings incompletos para ${model}.`);
  return result.embeddings;
}
export function chunkText(text: string): string[] {
  const size = Math.max(100, Number(process.env.CHUNK_SIZE) || 800), overlap = Math.min(size - 1, Math.max(0, Number(process.env.CHUNK_OVERLAP) || 120));
  const clean = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      // Evita cortar no meio de parágrafos/frases sem produzir trechos muito pequenos.
      const floor = start + Math.floor(size * 0.65);
      const boundary = Math.max(clean.lastIndexOf("\n\n", end), clean.lastIndexOf(". ", end), clean.lastIndexOf(" ", end));
      if (boundary >= floor) end = boundary + (clean[boundary] === "." ? 1 : 0);
    }
    const part = clean.slice(start, end).trim();
    if (part) out.push(part);
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return out;
}
export async function ask(notebookId: string, question: string) {
  const q = await embed(question);
  const rows = db.prepare("SELECT c.id,c.content,c.embedding,c.dimensions,d.name AS document_name,c.chunk_index FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.notebook_id=? AND d.status='processed'").all(notebookId) as any[];
  const scored = rows.map(r => {
    const stored = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.dimensions);
    if (q.length !== stored.length) return { ...r, score: -1 };
    let dot=0, aa=0, bb=0; for (let i=0;i<q.length;i++) { dot+=q[i]*stored[i]; aa+=q[i]*q[i]; bb+=stored[i]*stored[i]; }
    return { ...r, score: dot / (Math.sqrt(aa*bb) || 1) };
  }).sort((a,b)=>b.score-a.score).slice(0, Math.min(8, Math.max(1, Number(process.env.RETRIEVAL_TOP_K)||4))).filter(x=>x.score>0);
  if (!rows.length) {
    const pending = db.prepare("SELECT count(*) AS n FROM documents WHERE notebook_id=? AND status='processing'").get(notebookId) as {n:number};
    const failed = db.prepare("SELECT count(*) AS n FROM documents WHERE notebook_id=? AND status='failed'").get(notebookId) as {n:number};
    const message = pending.n ? "Ainda estou processando os documentos deste notebook. Aguarde a conclusão e tente novamente." : failed.n ? "Não há documentos processados. Um ou mais documentos falharam; verifique o erro e use Reprocessar." : "Este notebook ainda não tem documentos processados. Adicione um arquivo ou texto antes de perguntar.";
    return { answer: message, sources: [] };
  }
  if (!scored.length) return { answer: "Não encontrei informações suficientes nos trechos recuperados deste notebook para responder. Tente reformular a pergunta com termos mais específicos.", sources: [] };
  const contextLimit = Math.max(2_000, Number(process.env.MAX_CONTEXT_CHARS) || 7_000);
  let used = 0;
  const contextParts: string[] = [];
  for (let i = 0; i < scored.length && used < contextLimit; i++) {
    const s = scored[i];
    const header = `[Fonte ${i+1}: ${s.document_name}, trecho ${s.chunk_index+1}]\n`;
    const remaining = contextLimit - used - header.length;
    if (remaining <= 0) break;
    const part = header + s.content.slice(0, remaining);
    contextParts.push(part);
    used += part.length + 2;
  }
  const context = contextParts.join("\n\n");
  const result = await ollama("/api/chat", { model: process.env.OLLAMA_CHAT_MODEL || "qwen2.5:1.5b-instruct", stream: false, keep_alive: process.env.OLLAMA_KEEP_ALIVE || "5m", options: { temperature: 0.1, top_p: 0.8, num_ctx: Math.max(2048, Number(process.env.OLLAMA_NUM_CTX) || 4096), num_predict: Math.max(128, Number(process.env.OLLAMA_NUM_PREDICT) || 512) }, messages: [
    { role: "system", content: "Responda em português claro e direto. Use somente o CONTEXTO; não invente nem use conhecimento externo. Se a informação não estiver nos trechos, diga isso. Combine trechos relevantes e cite as evidências como [Fonte 1]. Para resumo, priorize os pontos principais em poucos tópicos." },
    { role: "user", content: `CONTEXTO:\n${context}\n\nPERGUNTA:\n${question}` }
  ] });
  return { answer: result.message?.content || "O modelo não retornou resposta.", sources: scored.map((s,i)=>({ id:s.id, document:s.document_name, excerpt:s.content.slice(0,320), score:Number(s.score.toFixed(4)), label:`Fonte ${i+1}` })) };
}
export const uuid = () => crypto.randomUUID();
