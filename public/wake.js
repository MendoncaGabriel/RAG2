// Palavra de ativação do modo de voz: "Bento", "Oi Bento", "Ok Bento", "Ei Bento"…
// Função pura sobre o texto já transcrito (sem áudio): o modo de voz a usa para interromper a resposta falada
// só quando o usuário chama pelo nome (e não a cada ruído ou conversa ao redor) e para tirar o chamado do começo da pergunta.
(() => {
  const strip = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Como o reconhecimento costuma escrever o nome; "vento"/"mento" ficam de fora de propósito (palavras comuns).
  const NAME = new Set(['bento', 'bendo', 'bentu']);
  const STRONG = new Set(['ok', 'okay', 'okey', 'oquei', 'oi', 'ola', 'ei', 'hey', 'ey']); // chamado inequívoco antes do nome
  // Enganos comuns do reconhecimento com o "oi" ("Fui Bento", "O Ibento", "8 Bento", medidos em fala com ruído): valem só como chamado
  // enquanto a IA fala; no começo de uma pergunta comum não são tirados.
  const PRE = new Set([...STRONG, 'opa', 'e', 'ai', 'fala', 'fui', 'foi', 'oh', 'hoi', 'voi', 'oy', 'o', '8']);
  const GLUED = /^(?:ok|okay|oi|ei|hey|fui|foi|o|i|oh)(?:bento|bendo|bentu)$/; // "okbento", "ibento" colados
  const MAX_BEFORE = 2; // até 2 palavras de chamado antes do nome ("e aí Bento")

  // Devolve null se o texto não chama o Bento; senão { rest, pre, comma }:
  // rest = o que veio depois do chamado (pergunta já dita junto), pre = teve "ok/oi/ei" antes, comma = nome seguido de pontuação.
  function match(text) {
    const src = String(text || ''), toks = [...src.matchAll(/[\p{L}\p{N}]+/gu)].map(m => ({ w: strip(m[0]), end: m.index + m[0].length }));
    let pre = false;
    for (let i = 0; i < toks.length && i <= MAX_BEFORE; i++) {
      const t = toks[i], next = toks[i + 1]; let end = 0;
      if (NAME.has(t.w)) end = t.end;
      else if (GLUED.test(t.w)) { end = t.end; pre ||= /^(ok|okay|oi|ei|hey)/.test(t.w) }
      else if ((t.w === 'ben' || t.w === 'bem') && (next?.w === 'to' || next?.w === 'tu')) end = next.end; // "ben to"
      else if (t.w === 'o' && next?.w === 'k') { pre = true; i++; continue } // "o k"
      else if (PRE.has(t.w)) { pre ||= STRONG.has(t.w); continue }
      else return null;
      const tail = src.slice(end);
      return { rest: tail.replace(/^[\s,.:;!?…-]+/, '').trim(), pre, comma: /^\s*[,:;!?.…-]/.test(tail) };
    }
    return null;
  }
  // Pergunta falada com o chamado no começo ("Ok Bento, quanto custa?"): tira o chamado só quando é claro que é um chamado
  // (palavra de chamado antes, vírgula depois, ou nada além do nome), para não alterar "Bento Gonçalves tem quantos habitantes?".
  const stripCall = text => { const m = match(text); return m && (m.pre || m.comma || !m.rest) ? m.rest : String(text || '').trim() };
  if (typeof window !== 'undefined') window.bentoWake = { match, stripCall };
  if (typeof globalThis !== 'undefined') globalThis.__bentoWake = { match, stripCall };
})();
