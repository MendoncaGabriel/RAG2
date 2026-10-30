// Chunking estrutural: respeita títulos, tabelas, listas e parágrafos em vez de cortar o texto por caracteres.
// Cada trecho carrega o caminho de seções ("# 9. Projetos > ### PRJ-ARARA") para ser compreensível isoladamente,
// e tabelas são divididas por grupos de linhas inteiras com o cabeçalho repetido: uma linha nunca é cortada ao meio,
// então o código, o nome e os atributos de um registro ficam sempre no mesmo trecho.

export type Chunk = { content: string; section: string };

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

type Block = { kind: "heading" | "table" | "list" | "text"; lines: string[]; level?: number };
const headingRe = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const isTableLine = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSeparator = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const isListLine = (l: string) => /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/.test(l);

function blocks(text: string): Block[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: Block[] = [];
  let cur = null as Block | null;
  const flush = () => { if (cur && cur.lines.some(l => l.trim())) out.push(cur); cur = null; };
  for (const raw of lines) {
    const line = raw.replace(/[ \t]+$/g, "");
    const h = line.match(headingRe);
    if (h) { flush(); out.push({ kind: "heading", lines: [h[2].replace(/\*\*/g, "").trim()], level: h[1].length }); continue; }
    if (!line.trim()) {
      // Linha em branco encerra tabela/parágrafo; listas toleram uma linha em branco entre itens.
      if (cur?.kind !== "list") flush();
      continue;
    }
    const kind: Block["kind"] = isTableLine(line) ? "table" : isListLine(line) ? "list" : (cur?.kind === "list" && /^\s{2,}\S/.test(raw)) ? "list" : "text";
    if (cur && cur.kind !== kind) flush();
    if (!cur) cur = { kind, lines: [] };
    cur.lines.push(line);
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
  const section = () => path.map(p => p.title).join(" > ");
  const prefix = (s: string) => s ? `[Seção: ${s}]\n` : "";
  const push = (body: string, s: string) => {
    const content = (prefix(s) + body).trim();
    if (body.trim().length < 30 && out.length) {
      // Fragmento curto (ex.: título solto) é anexado ao trecho anterior da mesma seção em vez de virar ruído.
      const last = out[out.length - 1];
      if (last.section === s && last.content.length + body.length < size * 1.3) { last.content += `\n${body.trim()}`; return; }
    }
    if (out.length && out[out.length - 1].content === content) return;
    out.push({ content, section: s });
  };
  const flushBuffer = () => { if (buffer.length) push(buffer.join("\n\n"), bufferSection); buffer = []; };
  const add = (unit: string) => {
    const s = section();
    if (buffer.length && (bufferSection !== s || buffer.join("\n\n").length + unit.length + 2 > size)) flushBuffer();
    bufferSection = s;
    buffer.push(unit);
  };
  for (const b of blocks(text)) {
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
