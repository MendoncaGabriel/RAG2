// Chunking estrutural: respeita títulos, tabelas, listas e parágrafos em vez de cortar o texto por caracteres.
// Cada trecho carrega o caminho de seções ("# 9. Projetos > ### PRJ-ARARA") para ser compreensível isoladamente,
// e tabelas são divididas por grupos de linhas inteiras com o cabeçalho repetido: uma linha nunca é cortada ao meio,
// então o código, o nome e os atributos de um registro ficam sempre no mesmo trecho.

// pageStart/pageEnd: páginas de origem (PDF), quando conhecidas.
export type Chunk = { content: string; section: string; pageStart?: number; pageEnd?: number };
// Marcador de página entre páginas do PDF (linha com form feed + número). Não entra no texto dos trechos.
export const pageMarker = (page: number) => `\f${page}`;
const pageMarkerRe = /^\f(\d{1,5})$/;
export const stripPageMarkers = (text: string) => text.replace(/^\f\d{1,5}\n?/gm, "");

const chunkSize = () => Math.max(100, Number(process.env.CHUNK_SIZE) || 700);
const chunkOverlap = (size: number) => Math.min(size - 1, Math.max(0, Number(process.env.CHUNK_OVERLAP) || 100));

// Divisão por caracteres respeitando parágrafos/frases; usada só para blocos de prosa maiores que um trecho.
export function splitProse(text: string, size = chunkSize(), overlap = chunkOverlap(size)): string[] {
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
    // Descarta pedaços sem conteúdo útil (só pontuação/rodapé curto) e repetidos em sequência: poluem a busca.
    if (part && (part.length >= 30 || !out.length) && part !== out[out.length - 1]) out.push(part);
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return out;
}

// ---------- Limpeza de PDF (por página) ----------
// Cabeçalhos/rodapés repetidos ("Initial release: …", "CONFIDENTIAL … Page 5 of 24"), linhas de sumário ("2.1 Forno ……… 5")
// e números de página poluem embeddings, BM25 e o contexto do modelo: capas e sumários passavam à frente do conteúdo.
// Só as bordas de cada página são consideradas para cabeçalho/rodapé ("Resolution:" repetido no corpo é conteúdo).
const tocLine = /(\.{5,}|…{2,}|(?:\. ){4,}\.?|_{5,})\s*\d{1,4}\s*$/;
const pageNumberLine = /^(?:p[aá]g(?:ina)?\.?|page)?\s*:?\s*\d{1,4}(?:\s*(?:of|de|\/)\s*\d{1,4})?$/i;
const lineKey = (line: string) => line.trim().toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ");
// Título numerado de PDF ("5.2 Oven Monitoring", "3.1 BACKEND FAILS TO START", "7.6 ERROR: \"…\"") vira título Markdown,
// para o trecho carregar a seção. Passos numerados ("1. Clone the repository") ficam: título exige palavras capitalizadas.
function numberedHeading(line: string): string | null {
  const m = line.trim().match(/^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+(\S.{1,90})$/);
  if (!m || Number(m[1].split(".")[0]) > 30) return null;
  const title = m[2].trim();
  if (!/^["“(]?[A-ZÀ-Ý]/.test(title) || /[.,;:]$/.test(title)) return null;
  const words = title.split(/\s+/);
  if (words.length > 12) return null;
  const significant = words.map(w => w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "")).filter(w => w.length >= 4);
  if (significant.some(w => !/^\p{Lu}/u.test(w))) return null;
  return `${"#".repeat(Math.min(6, m[1].split(".").length))} ${m[1]} ${title}`;
}
export function cleanPdfPages(pages: string[]): string {
  const split = pages.map(p => p.replace(/\r/g, "").split("\n"));
  // Bordas: 6 primeiras e 4 últimas linhas não vazias de cada página.
  const edges = split.map(lines => {
    const filled = lines.map((l, i) => (l.trim() ? i : -1)).filter(i => i >= 0);
    return new Set([...filled.slice(0, 6), ...filled.slice(-4)]);
  });
  // Cabeçalho/rodapé: repete na borda de muitas páginas e quase nunca aparece no miolo (rótulos como "Resolution:" aparecem).
  const seen = new Map<string, number>(), inner = new Map<string, number>();
  split.forEach((lines, p) => {
    for (const k of new Set([...edges[p]].map(i => lineKey(lines[i])))) seen.set(k, (seen.get(k) || 0) + 1);
    lines.forEach((l, i) => { if (l.trim() && !edges[p].has(i)) { const k = lineKey(l); inner.set(k, (inner.get(k) || 0) + 1); } });
  });
  const minPages = Math.max(3, Math.ceil(pages.length * 0.4));
  const repeated = pages.length >= 3 ? new Set([...seen].filter(([k, n]) => n >= minPages && k.length <= 150 && (inner.get(k) || 0) <= n * 0.25).map(([k]) => k)) : new Set<string>();
  return split.map((lines, p) => `${pageMarker(p + 1)}\n` + lines.flatMap((line, i) => {
    const t = line.trim();
    if (!t) return [line];
    if (edges[p].has(i) && (repeated.has(lineKey(line)) || pageNumberLine.test(t))) return [];
    if (tocLine.test(t)) return [];
    const heading = numberedHeading(t);
    if (heading) return [heading];
    // "#" no PDF é comentário de código (.env, shell), não título Markdown.
    return [/^#/.test(t) ? ` ${line}` : line];
  }).join("\n")).join("\n\n");
}

// Sumário (linhas com pontilhado até o número da página): não responde nada e, por concentrar palavras-chave, vencia a busca.
export const isTocChunk = (text: string) => {
  const lines = text.split("\n").filter(l => l.trim() && !/^\[Seção:/.test(l));
  const toc = lines.filter(l => /\.{6,}|…{3,}/.test(l)).length;
  return toc >= 2 && toc >= lines.length * 0.3;
};

type Block = { kind: "heading" | "table" | "list" | "text"; lines: string[]; level?: number; page?: number; pageEnd?: number };
const headingRe = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const isTableLine = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSeparator = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const isListLine = (l: string) => /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/.test(l);

function blocks(text: string): Block[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: Block[] = [];
  let cur = null as Block | null, page: number | undefined;
  const flush = () => { if (cur && cur.lines.some(l => l.trim())) out.push(cur); cur = null; };
  for (const raw of lines) {
    const marker = raw.match(pageMarkerRe);
    if (marker) { page = Number(marker[1]); continue; }
    const line = raw.replace(/[ \t]+$/g, "");
    const h = line.match(headingRe);
    if (h) { flush(); out.push({ kind: "heading", lines: [h[2].replace(/\*\*/g, "").trim()], level: h[1].length, page, pageEnd: page }); continue; }
    if (!line.trim()) {
      // Linha em branco encerra tabela/parágrafo; listas toleram uma linha em branco entre itens.
      if (cur?.kind !== "list") flush();
      continue;
    }
    const kind: Block["kind"] = isTableLine(line) ? "table" : isListLine(line) ? "list" : (cur?.kind === "list" && /^\s{2,}\S/.test(raw)) ? "list" : "text";
    if (cur && cur.kind !== kind) flush();
    if (!cur) cur = { kind, lines: [], page };
    cur.lines.push(line);
    cur.pageEnd = page;
  }
  flush();
  return out;
}

// Linhas de tabela viram unidades indivisíveis; o cabeçalho acompanha cada grupo.
function tableUnits(lines: string[], size: number): string[] {
  const sep = lines.findIndex(isSeparator);
  const header = sep > 0 ? lines.slice(0, sep + 1).join("\n") : "";
  const rows = sep > 0 ? lines.slice(sep + 1) : lines;
  const out: string[] = [];
  let group: string[] = [];
  const budget = Math.max(size - header.length, 120);
  for (const row of rows) {
    if (group.length && group.join("\n").length + row.length + 1 > budget) { out.push([header, ...group].filter(Boolean).join("\n")); group = []; }
    group.push(row);
  }
  if (group.length) out.push([header, ...group].filter(Boolean).join("\n"));
  return out;
}

export function chunkStructured(text: string): Chunk[] {
  const size = chunkSize();
  const path: { level: number; title: string }[] = [];
  const out: Chunk[] = [];
  let buffer: string[] = [], bufferSection = "";
  // Páginas do conteúdo em construção (PDF): primeira e última página dos blocos que formam o trecho.
  let pages: { start?: number; end?: number } = {}, bufferPages: typeof pages = {};
  const section = () => path.map(p => p.title).join(" > ");
  const prefix = (s: string) => s ? `[Seção: ${s}]\n` : "";
  const withPages = (c: Chunk, p: typeof pages) => (p.start ? { ...c, pageStart: p.start, pageEnd: p.end ?? p.start } : c);
  const push = (body: string, s: string, p = pages) => {
    const content = (prefix(s) + body).trim();
    if (body.trim().length < 30 && out.length) {
      // Fragmento curto (ex.: título solto) é anexado ao trecho anterior da mesma seção em vez de virar ruído.
      const last = out[out.length - 1];
      if (last.section === s && last.content.length + body.length < size * 1.3) { last.content += `\n${body.trim()}`; if (p.end && last.pageStart) last.pageEnd = Math.max(last.pageEnd ?? p.end, p.end); return; }
    }
    if (out.length && out[out.length - 1].content === content) return;
    out.push(withPages({ content, section: s }, p));
  };
  const flushBuffer = () => { if (buffer.length) push(buffer.join("\n\n"), bufferSection, bufferPages); buffer = []; bufferPages = {}; };
  const add = (unit: string) => {
    const s = section();
    if (buffer.length && (bufferSection !== s || buffer.join("\n\n").length + unit.length + 2 > size)) flushBuffer();
    bufferSection = s;
    buffer.push(unit);
    if (pages.start) bufferPages = { start: bufferPages.start ?? pages.start, end: pages.end ?? pages.start };
  };
  for (const b of blocks(text)) {
    pages = { start: b.page, end: b.pageEnd ?? b.page };
    if (b.kind === "heading") {
      flushBuffer();
      const level = b.level!;
      while (path.length && path[path.length - 1].level >= level) path.pop();
      path.push({ level, title: b.lines[0].slice(0, 140) });
      continue;
    }
    if (b.kind === "table") {
      flushBuffer();
      // Parágrafo curto imediatamente antes costuma ser a legenda; a tabela fica em trechos próprios.
      for (const unit of tableUnits(b.lines, size)) push(unit, section());
      continue;
    }
    const body = b.lines.join("\n");
    if (body.length <= size) { add(body); continue; }
    if (b.kind === "list") {
      // Lista longa: agrupa itens inteiros (com suas sublinhas) sem quebrar um item.
      const items: string[] = [];
      for (const line of b.lines) { if (isListLine(line) || !items.length) items.push(line); else items[items.length - 1] += `\n${line}`; }
      for (const item of items) item.length <= size ? add(item) : splitProse(item, size).forEach(add);
      continue;
    }
    flushBuffer();
    for (const part of splitProse(body, size)) push(part, section());
  }
  flushBuffer();
  return out;
}
