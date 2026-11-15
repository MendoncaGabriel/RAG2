// Roteamento do modo conversa (chat com "Conversa" ligado e modo de voz): decide se a mensagem precisa dos documentos (RAG) ou é
// conversa direta com a IA ("oi, tudo bem?", "obrigado", "quem é você?"), que não deve buscar trechos. Sem LLM: a decisão sai do
// texto em microssegundos (a voz não espera uma chamada extra); o resto vai à busca estrita, e sem trecho achado a IA conversa
// sem fontes (rag.ts). A nota do Cross-Encoder não serve de juiz: medida na base Verdanis, conversa ("que horas são?", "me conta
// uma piada") ficou entre -4,5 e -1,0 e perguntas reais também chegam a -4,2.
//  direct   — só cumprimento, cortesia, reação ou pergunta sobre a IA: responde sem buscar.
//  continue — "sim", "pode", "quero" logo depois de a IA oferecer aprofundar: busca o assunto anterior.
//  rag      — tem assunto: busca estrita (sem a relaxada, que traz trechos só "parecidos").
// Mensagem mista ("oi, bom dia! qual o orçamento do PRJ-ARARA?") vai ao RAG: as partes sociais são removidas e o que sobra decide.
import { normalizeText, stopWords } from "./sparse.js";
import { extractCodes } from "./structured.js";

export type RouteKind = "direct" | "continue" | "rag";
type Msg = { role: string; content: string };

// Frases sociais, sem acento e em minúsculas. Removidas da mensagem antes de ver se sobra assunto.
const social = [
  // cumprimentos e bem-estar
  "o+i+", "ol[aá]+", "opa", "e ai", "eai", "ei", "hey", "hi", "hello", "al[oô]", "salve", "fala ai", "fala",
  "bom dia", "boa tarde", "boa noite", "boa madrugada", "tudo bem", "tudo bom", "tudo certo", "tudo tranquilo", "tudo joia", "tudo ok",
  "tudo em ordem", "td bem", "tranquilo", "beleza", "blz", "suave", "de boa", "como( e que)? (vai|vais)( (voce|vc|tu))?", "como( e que)? (voce|vc|ce|tu) (vai|esta|ta|anda)",
  "como( e que)? (esta|ta)( (voce|vc))?", "como (tem|vem) passado", "como (voce|vc) (tem|vem) passado", "como andam as coisas", "como estao as coisas", "como foi (o )?seu dia",
  "(muito )?prazer( em (te )?conhecer)?", "(seja )?bem vind[oa]", "estou bem", "to bem", "tambem estou bem",
  // agradecimentos e despedidas
  "(muito )?obrigad[oa]", "brigad[oa]", "valeu", "vlw", "(pela|pelo|por) (sua )?(ajuda|explicacao|resposta|informacao|atencao|paciencia|conversa|forca|dica)", "agradec\\w*", "grat[oa]", "thanks", "thank you", "de nada",
  "tchau", "ate logo", "ate mais", "ate amanha", "ate a proxima", "ate breve", "falou", "boa semana", "bom fim de semana", "bom trabalho",
  "fica com deus", "se cuida",
  // desculpas
  "desculp[ae]", "foi mal", "perdao", "com licenca",
  // reações e confirmações
  "ok", "okay", "certo", "entendi", "entendido", "entendo", "compreendi", "saquei", "a+h+", "aham", "uhum", "h+u+m+", "h+m+", "ahn",
  "(que )?legal", "show( de bola)?", "massa", "top", "(que )?otimo", "perfeito", "excelente", "maravilha", "bacana", "(muito )?interessante",
  "nossa", "uau", "caramba", "serio", "verdade", "e mesmo", "faz sentido", "ta bom", "ta certo", "que bom", "bom saber", "muito bom",
  "isso ai", "fico (muito )?(feliz|contente)", "foi (muito )?(otimo|bom|legal|util|show|massa|de grande ajuda)", "ajudou (muito|bastante)", "gostei", "adorei", "k{3,}", "(ha){2,}h?", "rs+", "nao precisa", "nao obrigad[oa]", "deixa pra la", "esquece", "so isso", "e so isso",
  "por enquanto e so", "nada nao",
];
const socialRe = new RegExp(`\\b(${social.sort((a, b) => b.length - a.length).join("|")})\\b`, "g");
// "e você?" devolvendo a pergunta: só no fim e depois de testar as perguntas sobre a IA ("quem é você?" não pode virar "quem").
const tailRe = /\b(e )?(com )?(voce|vc|tu)$/;
// Palavras que sobram de frases sociais e não formam assunto.
const fillers = new Set(["entao", "cara", "amigo", "amiga", "meu", "minha", "querido", "querida", "assistente", "bento", "favor", "aqui", "novo",
  "novamente", "tambem", "muito", "bem", "voce", "voces", "boa", "bom", "tudo", "mesmo", "ainda", "agora", "hoje", "sim", "nao", "pra", "por",
  "foi", "eu", "isso", "esse", "essa", "dai", "assim", "demais", "bastante"]);
const affirmative = /^(sim|claro|pode|pode ser|pode sim|pode continuar|quero|quero sim|queria|bora|vamos|vamos la|manda|manda ver|por favor|isso|com certeza|aham|uhum|ok|gostaria|gostaria sim|continua|continue|aprofunda|aprofunde)( (sim|por favor|ai|entao))*$/;
// Perguntas sobre a própria IA (nome, o que faz, se está ouvindo), depois de tirar as partes sociais.
const aboutAssistant = /^(e )?(quem (e|es) (voce|vc|tu)|qual (e )?(o )?seu nome|como (voce|vc|tu) se chama|(o )?que (voce|vc) (e|faz|pode fazer|sabe fazer|consegue fazer)|(voce|vc) (e|eh) (uma? )?(ia|robo|humano|humana|pessoa|inteligencia artificial|chatbot|bot|real)|(voce|vc) (esta|ta) (ai|me ouvindo|ouvindo)|(esta|ta) me ouvindo|consegue me ouvir|me ouve|(voce|vc) (pode|consegue) me ajudar|pode me ajudar|me ajuda|preciso de ajuda|como (voce|vc) funciona)$/;

const bare = (text: string) => normalizeText(text).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
// Palavras de assunto: 3+ letras, fora das palavras vazias da busca e das sobras de frases sociais.
const contentWords = (text: string) => (text.match(/[\p{L}\p{N}]{3,}/gu) || []).filter(w => !stopWords.has(w) && !fillers.has(w));
// A última resposta terminou oferecendo algo ("quer que eu aprofunde?").
const offered = (history: Msg[]) => { const last = history.at(-1); return last?.role === "assistant" && /\?\s*$/.test(last.content.trim().slice(-200)); };

export function conversationRoute(message: string, history: Msg[] = []): { kind: RouteKind; residue: string } {
  if (extractCodes(message).length) return { kind: "rag", residue: message };
  const text = bare(message);
  if (!text) return { kind: "direct", residue: "" };
  if (affirmative.test(text)) return { kind: offered(history) ? "continue" : "direct", residue: "" };
  const cleaned = text.replace(socialRe, " ").replace(/\s+/g, " ").trim();
  if (aboutAssistant.test(cleaned)) return { kind: "direct", residue: cleaned };
  const residue = cleaned.replace(tailRe, "").trim();
  return { kind: contentWords(residue).length ? "rag" : "direct", residue };
}

// Histórico para a busca sem as trocas de conversa direta: "oi, tudo bem?" não pode virar o assunto de "e o prazo dele?".
export function withoutSmallTalk(history: Msg[]): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role === "user" && conversationRoute(m.content, out).kind === "direct") { if (history[i + 1]?.role === "assistant") i++; continue; }
    out.push(m);
  }
  return out;
}
