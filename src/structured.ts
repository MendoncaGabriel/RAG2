// Registros estruturados: tabelas Markdown/planilhas e fichas "### CÓDIGO — Título" + "- **Campo:** valor" viram linhas
// consultáveis. Perguntas de filtro, contagem, soma, média, ordenação e listagem completa são respondidas por código
// determinístico sobre esses registros, em vez de depender do top-K de trechos e de o modelo pequeno fazer contas.
import { db } from "./database.js";

export type RecordRow = { id: string; document_id: string; document_name: string; table_key: string; title: string; headers: string[]; fields: Record<string, string>; row_index: number };
export type Source = { id: string; document: string; type: string; section?: string; excerpt: string; score: number; label: string };

const norm = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const clean = (t: string) => t.replace(/`|\*\*/g, "").trim();
const stop = new Set(["com", "como", "para", "pela", "pelo", "que", "qual", "quais", "quando", "onde", "sobre", "seus", "suas", "este", "esta", "isso", "essa", "dos", "das", "nos", "nas", "sao", "tem", "tém", "têm", "possuem", "possui", "estao", "esta", "foram", "foi", "ser", "uma", "uns", "umas", "todo", "toda", "todos", "todas", "liste", "listar", "lista", "enumere", "mostre", "quantos", "quantas", "qual", "media", "medio", "soma", "total", "valor", "acima", "abaixo", "superior", "inferior", "maior", "menor", "mais", "menos", "ordene", "ordem", "registrado", "registrados", "registradas", "existem", "ha", "the", "and", "for"]);
const stem = (t: string) => t.replace(/s$/, "").slice(0, 6);
const stems = (t: string) => (norm(t).match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => !stop.has(w)).map(stem);
export const extractCodes = (t: string) => [...new Set((t.match(/\b[A-Za-z]{2,10}(?:-[A-Za-z0-9]+)+\b/g) || []).filter(c => /[A-Z]/.test(c) || /\d/.test(c)).map(c => c.toUpperCase()))];

// ---------- Extração ----------
const headingRe = /^(#{1,6})\s+(.+?)\s*$/;
const splitRow = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(clean);
const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);

export function extractRecords(text: string): Omit<RecordRow, "id" | "document_id" | "document_name">[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: Omit<RecordRow, "id" | "document_id" | "document_name">[] = [];
  const path: { level: number; title: string }[] = [];
  const section = (upTo = path.length) => path.slice(0, upTo).map(p => p.title).join(" > ");
  let i = 0;
  while (i < lines.length) {
    const h = lines[i].match(headingRe);
    if (h) {
      const level = h[1].length, title = clean(h[2]);
      while (path.length && path[path.length - 1].level >= level) path.pop();
      path.push({ level, title });
      // Ficha: título com código seguido de lista "- **Campo:** valor" (ex.: incidentes).
      const fields: Record<string, string> = {};
      let j = i + 1;
      while (j < lines.length && !headingRe.test(lines[j])) {
        const m = lines[j].match(/^\s*[-*]\s+\*\*([^*:]{1,60}):?\*\*:?\s*(.+)$/);
        if (m) fields[clean(m[1])] = clean(m[2]);
        else if (lines[j].trim() && Object.keys(fields).length) break;
        j++;
      }
      const code = extractCodes(title)[0];
      if (code && Object.keys(fields).length >= 3) {
        const rest = clean(title.replace(new RegExp(code.replace(/[-]/g, "\\-"), "i"), "").replace(/^[\s—–:-]+/, ""));
        const all = { "Código": code, "Título": rest, ...fields };
        const headers = Object.keys(all);
        out.push({ table_key: `${section(path.length - 1)}|${Object.keys(fields).sort().join("|")}`, title: section(path.length - 1), headers, fields: all, row_index: out.length });
      }
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const headers = splitRow(lines[i]).map((hd, k) => hd || `Coluna ${k + 1}`);
      const key = `${section()}|${headers.join("|")}`;
      let j = i + 2, n = 0;
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
        const cells = splitRow(lines[j]);
        const fields: Record<string, string> = {};
        headers.forEach((hd, k) => { fields[hd] = cells[k] ?? ""; });
        if (cells.some(Boolean)) out.push({ table_key: key, title: section(), headers, fields, row_index: n++ });
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

// Planilhas/CSV viram tabela Markdown: cada trecho repete o cabeçalho e cada linha fica íntegra.
export function rowsToMarkdown(rows: unknown[][], maxRows = 5000): string {
  const data = rows.filter(r => Array.isArray(r) && r.some(c => String(c ?? "").trim())).slice(0, maxRows + 1);
  if (!data.length) return "";
  const width = Math.max(...data.map(r => r.length));
  const cell = (c: unknown) => String(c ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  const line = (r: unknown[]) => `| ${Array.from({ length: width }, (_, k) => cell(r[k])).join(" | ")} |`;
  return [line(data[0]), `|${Array.from({ length: width }, () => "---").join("|")}|`, ...data.slice(1).map(line)].join("\n");
}
export function csvToMarkdown(text: string): string {
  const sepChar = (text.split("\n")[0].match(/;/g)?.length || 0) > (text.split("\n")[0].match(/,/g)?.length || 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cur = "", quoted = false;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (quoted) { if (ch === '"' && text[k + 1] === '"') { cur += '"'; k++; } else if (ch === '"') quoted = false; else cur += ch; continue; }
    if (ch === '"') quoted = true;
    else if (ch === sepChar) { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur.replace(/\r$/, "")); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rowsToMarkdown(rows);
}

export function saveRecords(documentId: string, notebookId: string, text: string) {
  const records = extractRecords(text);
  const insert = db.prepare("INSERT INTO records(id,document_id,notebook_id,table_key,title,headers,fields,row_index) VALUES(?,?,?,?,?,?,?,?)");
  db.prepare("DELETE FROM records WHERE document_id=?").run(documentId);
  for (const r of records) insert.run(crypto.randomUUID(), documentId, notebookId, r.table_key, r.title, JSON.stringify(r.headers), JSON.stringify(r.fields), r.row_index);
  db.prepare("UPDATE documents SET records_version=1 WHERE id=?").run(documentId);
  recordCache.delete(notebookId);
  return records.length;
}

// ---------- Valores ----------
export type Num = { value: number; unit: "BRL" | "%" | "min" | "" };
const brNumber = (s: string) => {
  const t = s.trim();
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) return Number(t.replace(/\./g, "").replace(",", "."));
  if (/^\d+(,\d+)?$/.test(t)) return Number(t.replace(",", "."));
  if (/^\d+\.\d+$/.test(t)) return Number(t);
  return NaN;
};
export function parseValue(raw: string): Num | null {
  const s = norm(clean(raw)).replace(/\s+/g, " ").trim();
  if (!s || /\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}/.test(s)) return null;
  let m = s.match(/^(\d+)\s*h\s*(\d+)\s*min$/);
  if (m) return { value: Number(m[1]) * 60 + Number(m[2]), unit: "min" };
  if ((m = s.match(/^(\d+)\s*min(?:utos)?$/))) return { value: Number(m[1]), unit: "min" };
  if ((m = s.match(/^(\d+(?:,\d+)?)\s*h(?:oras?)?$/))) return { value: brNumber(m[1]) * 60, unit: "min" };
  if ((m = s.match(/^r\$\s*([\d.,]+)$/))) { const v = brNumber(m[1]); return Number.isFinite(v) ? { value: v, unit: "BRL" } : null; }
  if ((m = s.match(/^([\d.,]+)\s*%/))) { const v = brNumber(m[1]); return Number.isFinite(v) ? { value: v, unit: "%" } : null; }
  if ((m = s.match(/^([\d.,]+)(?:\s*(?:un|unidades|dias?|kg|tb|gb))?$/))) { const v = brNumber(m[1]); return Number.isFinite(v) ? { value: v, unit: "" } : null; }
  return null;
}
const fmtNumber = (v: number, digits = 2) => v.toLocaleString("pt-BR", { maximumFractionDigits: digits });
export function formatValue(n: Num): string {
  if (n.unit === "BRL") return `R$ ${n.value.toLocaleString("pt-BR", { minimumFractionDigits: Number.isInteger(n.value) ? 0 : 2, maximumFractionDigits: 2 })}`;
  if (n.unit === "%") return `${fmtNumber(n.value)}%`;
  if (n.unit === "min") { const h = Math.floor(n.value / 60), m = Math.round(n.value - h * 60); return n.value >= 60 ? `${fmtNumber(n.value, 1)} min (${h}h ${String(m).padStart(2, "0")}min)` : `${fmtNumber(n.value, 1)} min`; }
  return fmtNumber(n.value);
}

// ---------- Cache por notebook ----------
type Table = { key: string; title: string; headers: string[]; rows: RecordRow[]; numeric: Set<string>; searchStems: Set<string> };
const recordCache = new Map<string, { signature: string; tables: Table[] }>();
export const invalidateRecords = (notebookId: string) => { recordCache.delete(notebookId); };
function loadTables(notebookId: string): Table[] {
  const sig = db.prepare("SELECT count(*) AS n, coalesce(max(r.rowid),0) AS m FROM records r JOIN documents d ON d.id=r.document_id WHERE r.notebook_id=? AND d.status='processed'").get(notebookId) as { n: number; m: number };
  const signature = `${sig.n}:${sig.m}`;
  const cached = recordCache.get(notebookId);
  if (cached?.signature === signature) return cached.tables;
  const byKey = new Map<string, Table>();
  for (const r of db.prepare("SELECT r.id,r.document_id,d.name AS document_name,r.table_key,r.title,r.headers,r.fields,r.row_index FROM records r JOIN documents d ON d.id=r.document_id WHERE r.notebook_id=? AND d.status='processed' ORDER BY r.document_id,r.table_key,r.row_index").iterate(notebookId) as Iterable<any>) {
    const row: RecordRow = { ...r, headers: JSON.parse(r.headers), fields: JSON.parse(r.fields) };
    const key = `${r.document_id}|${r.table_key}`;
    let t = byKey.get(key);
    if (!t) byKey.set(key, t = { key, title: r.title, headers: row.headers, rows: [], numeric: new Set(), searchStems: new Set([...stems(r.title), ...row.headers.flatMap(stems)]) });
    t.rows.push(row);
  }
  for (const t of byKey.values()) for (const h of t.headers) {
    const parsed = t.rows.filter(r => parseValue(r.fields[h] || "")).length;
    if (parsed >= Math.max(1, Math.ceil(t.rows.length * 0.6))) t.numeric.add(h);
  }
  const tables = [...byKey.values()];
  recordCache.set(notebookId, { signature, tables });
  while (recordCache.size > 8) recordCache.delete(recordCache.keys().next().value!);
  return tables;
}

// ---------- Interpretação da pergunta ----------
export type QueryIntent = { codes: string[]; list: boolean; comparator?: "gt" | "lt"; threshold?: Num; afterComparator?: string; aggregate?: "avg" | "sum" | "count" | "max" | "min"; order?: "asc" | "desc"; temporal: string[] };
const months = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export function analyzeQuery(question: string): QueryIntent {
  const q = norm(question);
  const intent: QueryIntent = { codes: extractCodes(question), list: /\b(liste|listar|lista|enumere|todos|todas|quais|relacione|mostre)\b/.test(q), temporal: [] };
  const cmp = q.match(/\b(acima d[eoa]s?|superior(?:es)? a[os]?|maior(?:es)? (?:que|do que)|mais de|excede\w*|ultrapass\w*)\s+(.{0,60})/) || null;
  const cmpLt = q.match(/\b(abaixo d[eoa]s?|inferior(?:es)? a[os]?|menor(?:es)? (?:que|do que)|menos de)\s+(.{0,60})/) || null;
  const hit = cmp || cmpLt;
  if (hit) {
    intent.comparator = cmp ? "gt" : "lt";
    intent.afterComparator = hit[2];
    const m = hit[2].match(/^(r\$\s*)?([\d.,]*\d)\s*(mil\b|milh[aã]o|milh[oõ]es|%|h\b|horas?|min\w*)?/);
    if (m) {
      let v = brNumber(m[2]);
      const mult = m[3] || "";
      if (/^mil$/.test(mult)) v *= 1e3; else if (/^milh/.test(mult)) v *= 1e6;
      const unit: Num["unit"] = m[1] ? "BRL" : mult === "%" ? "%" : /^(h|hora)/.test(mult) ? "min" : /^min/.test(mult) ? "min" : "";
      if (/^(h|hora)/.test(mult)) v *= 60;
      if (Number.isFinite(v)) intent.threshold = { value: v, unit };
    }
  }
  if (/\b(media|medio|mttr|em media)\b/.test(q)) intent.aggregate = "avg";
  else if (/\b(soma|somatorio|somando|total d[eoa]s?|valor total|soma d[eoa]s?)\b/.test(q)) intent.aggregate = "sum";
  else if (/\b(quantos|quantas|quantidade de|numero de|contagem)\b/.test(q)) intent.aggregate = "count";
  if (/\b(orden\w*|classifi\w*|ranking|decrescente|crescente|do maior para o menor|do menor para o maior)\b/.test(q)) intent.order = /crescente(?!.)|do menor para o maior/.test(q) && !/decrescente/.test(q) ? "asc" : "desc";
  else if (!intent.comparator && !intent.aggregate && /\b(maior|mais alto|mais alta|mais caro|mais cara)\b/.test(q)) intent.aggregate = "max";
  else if (!intent.comparator && !intent.aggregate && /\b(menor|mais baixo|mais baixa|mais barato|mais barata)\b/.test(q)) intent.aggregate = "min";
  for (const [k, m] of months.entries()) {
    if (new RegExp(`\\b${m}\\b`).test(q)) intent.temporal.push(m, `/${String(k + 1).padStart(2, "0")}/`);
  }
  for (const y of q.match(/\b20\d{2}\b/g) || []) intent.temporal.push(y);
  if (/primeiro semestre/.test(q)) intent.temporal.push("primeiro semestre", "ate junho");
  return intent;
}

// ---------- Resposta estruturada ----------
export type Structured = { kind: "direct"; answer: string; sources: Source[] } | { kind: "records"; block: string; sources: Source[] };
const rowLabel = (t: Table, r: RecordRow) => {
  const [a, b] = t.headers;
  const first = r.fields[a] || "", second = b && !t.numeric.has(b) ? r.fields[b] : "";
  return second && second !== first ? `${first} — ${second}` : first;
};
const rowText = (t: Table, r: RecordRow) => t.headers.map(h => `${h}: ${r.fields[h] || "-"}`).join("; ");
const sourceOf = (t: Table, rows: RecordRow[], label: string): Source => ({
  id: rows[0]?.id || t.key, document: rows[0]?.document_name || "", type: "record", section: t.title, label,
  excerpt: rows.slice(0, 12).map(r => rowText(t, r)).join("\n").slice(0, 1200) + (rows.length > 12 ? `\n… (+${rows.length - 12} registros)` : ""), score: 1,
});
function bestColumn(t: Table, text: string, pool: string[], exclude?: string): { col?: string; overlap: number } {
  const qs = new Set(stems(text));
  let col: string | undefined, overlap = 0;
  for (const h of pool) {
    if (h === exclude) continue;
    const o = stems(h).filter(s => qs.has(s)).length;
    if (o > overlap) { overlap = o; col = h; }
  }
  return { col, overlap };
}

export function structuredQuery(notebookId: string, question: string, intent = analyzeQuery(question)): Structured | null {
  const tables = loadTables(notebookId);
  if (!tables.length) return null;
  const q = norm(question);
  const codeSet = new Set(intent.codes);
  const qStems = stems(question.replace(/\b[A-Za-z]{2,10}(?:-[A-Za-z0-9]+)+\b/g, " "));
  // Relevância temática: substantivos da pergunta presentes no título/cabeçalhos da tabela.
  const scored = tables.map(t => {
    const topic = qStems.filter(s => t.searchStems.has(s)).length;
    const codes = codeSet.size ? t.rows.filter(r => Object.values(r.fields).some(v => extractCodes(v).some(c => codeSet.has(c)))).length : 0;
    return { t, topic, codes };
  }).sort((a, b) => (b.topic * 3 + Math.min(b.codes, 3)) - (a.topic * 3 + Math.min(a.codes, 3)));

  // Filtros de igualdade: valores de células citados na pergunta ("P1", "Bianca Reis", "classe A", "Em execução").
  const equalityFilters = (t: Table) => {
    const filters: { col: string; value: string }[] = [];
    for (const h of t.headers) {
      if (t.numeric.has(h)) continue;
      const values = [...new Set(t.rows.map(r => r.fields[h]).filter(Boolean))];
      const isCodeCol = values.every(v => extractCodes(v).length === 1 && extractCodes(v)[0] === v.toUpperCase());
      for (const v of values) {
        const nv = norm(v);
        if (nv.length > 60) continue;
        const escaped = nv.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const direct = (nv.length >= 3 || /\d/.test(nv)) && new RegExp(`(^|[^\\p{L}\\p{N}-])${escaped}($|[^\\p{L}\\p{N}-])`, "u").test(q);
        const withHeader = new RegExp(`\\b${norm(h).split(/[\s/]+/)[0]}\\s+${escaped}\\b`).test(q);
        if ((direct && (isCodeCol || values.length < t.rows.length || nv.split(" ").length >= 2)) || withHeader) { filters.push({ col: h, value: v }); break; }
      }
    }
    return filters;
  };

  for (const { t, topic } of scored) {
    if (topic < 1) break;
    // "Quantos dias de retenção…" não é contagem de registros: exige que o objeto contado seja o assunto da tabela.
    if (intent.aggregate === "count") {
      const counted = q.match(/\b(?:quant[oa]s|quantidade de|numero de)\s+(?:de\s+)?([\p{L}]+)/u)?.[1];
      if (!counted || !t.searchStems.has(stem(counted))) continue;
    }
    const numericCols = [...t.numeric];
    const filters = equalityFilters(t);
    let rows = t.rows.filter(r => filters.every(f => r.fields[f.col] === f.value));
    const steps: string[] = filters.map(f => `${f.col} = ${f.value}`);
    let valueCol: string | undefined;
    if (intent.comparator) {
      if (intent.threshold) {
        const pick = bestColumn(t, question, numericCols);
        valueCol = pick.col || (numericCols.length === 1 ? numericCols[0] : numericCols.find(h => t.rows.some(r => parseValue(r.fields[h])?.unit === intent.threshold!.unit && intent.threshold!.unit)));
        if (!valueCol) continue;
        const th = intent.threshold.value;
        rows = rows.filter(r => { const v = parseValue(r.fields[valueCol!]); return v != null && (intent.comparator === "gt" ? v.value > th : v.value < th); });
        steps.push(`${valueCol} ${intent.comparator === "gt" ? ">" : "<"} ${formatValue({ value: th, unit: parseValue(t.rows[0].fields[valueCol])?.unit || intent.threshold.unit })}`);
      } else {
        // Comparação entre colunas: "abaixo do estoque mínimo" compara a coluna citada com a coluna de valor atual.
        const ref = bestColumn(t, intent.afterComparator || "", numericCols);
        if (!ref.col || ref.overlap < 1) continue;
        const others = numericCols.filter(h => h !== ref.col);
        valueCol = others.find(h => /atual|realizado|valor|saldo/.test(norm(h))) || (others.length === 1 ? others[0] : bestColumn(t, question, others).col);
        if (!valueCol) continue;
        rows = rows.filter(r => { const a = parseValue(r.fields[valueCol!]), b = parseValue(r.fields[ref.col!]); return a != null && b != null && (intent.comparator === "gt" ? a.value > b.value : a.value < b.value); });
        steps.push(`${valueCol} ${intent.comparator === "gt" ? ">" : "<"} ${ref.col}`);
      }
    }
    if (intent.aggregate && intent.aggregate !== "count" || intent.order) {
      if (!valueCol) {
        const pick = bestColumn(t, question, numericCols);
        valueCol = pick.col || (numericCols.length === 1 ? numericCols[0] : undefined);
      }
      if (!valueCol) continue;
    }
    const isLookup = !intent.comparator && !intent.aggregate && !intent.order && !(intent.list && filters.length && rows.length > 1) && !(intent.list && !filters.length && topic >= 2);
    if (isLookup) continue;
    if (!rows.length) {
      return { kind: "direct", answer: `Nenhum registro de "${t.title}" atende ao critério (${steps.join("; ") || "sem filtro"}).`, sources: [sourceOf(t, t.rows, "Fonte 1")] };
    }
    const values = valueCol ? rows.map(r => ({ r, v: parseValue(r.fields[valueCol!]) })) : [];
    const valid = values.filter((x): x is { r: RecordRow; v: Num } => !!x.v);
    const unit = valid[0]?.v.unit || "";
    const lines: string[] = [];
    const scope = `${rows.length} ${rows.length === 1 ? "registro" : "registros"} de "${t.title}"${steps.length ? ` com ${steps.join(" e ")}` : ""}`;
    const listing = (items: RecordRow[]) => items.map(r => `- ${rowLabel(t, r)}${valueCol ? `: ${r.fields[valueCol]}` : ""}`);
    if (intent.aggregate === "count") {
      lines.push(`Total: ${rows.length} (${scope}).`, ...listing(rows));
    } else if (intent.aggregate === "sum" || intent.aggregate === "avg") {
      if (!valid.length) continue;
      const sum = valid.reduce((s, x) => s + x.v.value, 0);
      const result = intent.aggregate === "sum" ? sum : sum / valid.length;
      const ignored = rows.length - valid.length;
      lines.push(`${intent.aggregate === "sum" ? "Soma" : "Média"} de ${valueCol}: ${formatValue({ value: result, unit })} (${scope}${ignored ? `; ${ignored} sem valor numérico ignorado(s)` : ""}).`);
      lines.push(`Cálculo: (${valid.map(x => unit === "min" ? fmtNumber(x.v.value) : formatValue(x.v)).join(" + ")})${intent.aggregate === "avg" ? ` / ${valid.length}` : ""} = ${formatValue({ value: result, unit })}`);
      lines.push(...valid.map(x => `- ${rowLabel(t, x.r)}: ${x.r.fields[valueCol!]}`));
    } else if (intent.aggregate === "max" || intent.aggregate === "min") {
      if (!valid.length) continue;
      const best = valid.reduce((a, b) => (intent.aggregate === "max" ? b.v.value > a.v.value : b.v.value < a.v.value) ? b : a);
      const ties = valid.filter(x => x.v.value === best.v.value);
      lines.push(`${intent.aggregate === "max" ? "Maior" : "Menor"} ${valueCol}: ${ties.map(x => `${rowLabel(t, x.r)} (${x.r.fields[valueCol!]})`).join(", ")} — entre ${scope}.`);
    } else if (intent.order) {
      const sorted = [...valid].sort((a, b) => intent.order === "asc" ? a.v.value - b.v.value : b.v.value - a.v.value);
      lines.push(`${scope}, ordenados por ${valueCol} (${intent.order === "asc" ? "crescente" : "decrescente"}):`, ...sorted.map((x, k) => `${k + 1}. ${rowLabel(t, x.r)}: ${x.r.fields[valueCol!]}`));
    } else {
      lines.push(`${rows.length === 1 ? "Encontrado" : "Encontrados"} ${scope}:`, ...listing(rows));
    }
    return { kind: "direct", answer: lines.join("\n"), sources: [sourceOf(t, rows, "Fonte 1")] };
  }

  // Busca por código exato: entrega o registro completo para o modelo não misturar atributos de linhas vizinhas.
  if (codeSet.size) {
    const hits: { t: Table; r: RecordRow }[] = [];
    for (const t of tables) for (const r of t.rows) {
      const primary = extractCodes(r.fields[t.headers[0]] || "");
      if (primary.some(c => codeSet.has(c))) hits.push({ t, r });
    }
    if (hits.length && hits.length <= 4) {
      const block = hits.map(({ t, r }) => `[Registro: ${t.title}] ${rowText(t, r)}`).join("\n");
      return { kind: "records", block, sources: hits.map(({ t, r }, k) => sourceOf(t, [r], `Registro ${k + 1}`)) };
    }
  }
  return null;
}
