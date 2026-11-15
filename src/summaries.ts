// Resumos por documento guardados: gravados pelo One page (que lê cada documento inteiro) e reaproveitados
// nas próximas gerações e nas perguntas de resumo do chat ("resuma o notebook"), que passam a cobrir cada documento inteiro em
// vez de alguns trechos amostrados. O resumo vale enquanto o conteúdo do documento não muda (assinatura: nº e tamanho dos trechos).
import { db } from "./database.js";

db.exec(`CREATE TABLE IF NOT EXISTS document_summaries(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  lead TEXT NOT NULL, bullets TEXT NOT NULL, signature TEXT NOT NULL, detailed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);

export type DocumentSummary = { lead: string; bullets: string[] };
const signature = (documentId: string) => {
  const r = db.prepare("SELECT count(*) AS n, coalesce(sum(length(content)),0) AS len FROM chunks WHERE document_id=?").get(documentId) as { n: number; len: number };
  return `${r.n}:${r.len}`;
};

// Resumo guardado e ainda válido (o documento não foi reprocessado com outro conteúdo).
export function cachedSummary(documentId: string): DocumentSummary | null {
  const row = db.prepare("SELECT lead,bullets,signature FROM document_summaries WHERE document_id=?").get(documentId) as { lead: string; bullets: string; signature: string } | undefined;
  if (!row || row.signature !== signature(documentId)) return null;
  return { lead: row.lead, bullets: JSON.parse(row.bullets) };
}

// detailed: veio do resumo detalhado (o documento inteiro, parte por parte); não é substituído pelo resumo por amostra do One page.
export function saveSummary(documentId: string, summary: DocumentSummary, detailed = false) {
  if (!summary.lead.trim()) return;
  const sig = signature(documentId);
  const current = db.prepare("SELECT signature,detailed FROM document_summaries WHERE document_id=?").get(documentId) as { signature: string; detailed: number } | undefined;
  if (current && current.detailed && !detailed && current.signature === sig) return;
  db.prepare(`INSERT INTO document_summaries(document_id,lead,bullets,signature,detailed) VALUES(?,?,?,?,?)
    ON CONFLICT(document_id) DO UPDATE SET lead=excluded.lead,bullets=excluded.bullets,signature=excluded.signature,detailed=excluded.detailed,created_at=datetime('now')`)
    .run(documentId, summary.lead.trim(), JSON.stringify(summary.bullets), sig, detailed ? 1 : 0);
}

// Pergunta de resumo do chat: um item por documento com resumo guardado (na ordem dos documentos), ou null se menos da metade
// dos documentos tem resumo (aí vale a amostra de trechos de sempre). Documentos sem resumo entram com o trecho inicial.
export function summaryItems(notebookId: string, scope?: string[] | null): any[] | null {
  const docs = (db.prepare("SELECT id,name FROM documents WHERE notebook_id=? AND status='processed' ORDER BY created_at").all(notebookId) as { id: string; name: string }[])
    .filter(d => !scope?.length || scope.includes(d.id));
  if (!docs.length) return null;
  const withSummary = docs.map(d => ({ d, s: cachedSummary(d.id) }));
  if (withSummary.filter(x => x.s).length * 2 < docs.length) return null;
  const first = db.prepare("SELECT id,content,chunk_index FROM chunks WHERE document_id=? ORDER BY chunk_index LIMIT 1");
  return withSummary.map(({ d, s }) => {
    if (s) return { id: `summary:${d.id}`, content: [s.lead, ...s.bullets.map(b => `- ${b}`)].join("\n"), document_name: `${d.name} (resumo do documento)`, source_type: "document_summary", document_id: null, chunk_index: 0, score: 1 };
    const row = first.get(d.id) as { id: string; content: string; chunk_index: number } | undefined;
    return row ? { ...row, document_name: d.name, source_type: "document", document_id: d.id, score: 1 } : null;
  }).filter(Boolean);
}
