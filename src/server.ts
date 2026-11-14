import { config, validateConfig } from "./config.js";
import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { currentUser, login, logout, rateLimit } from "./auth.js";
import { db, dbPath, uploadDir } from "./database.js";
import { ask, chatContext, prepareReranker, tuneTarget, uuid } from "./rag.js";
import { autoTune } from "./tuning.js";
import { activeSummary, chat, createProvider, deleteProvider, getProvider, listModels, listProviders, ollamaStatus, providerKinds, setActive, testProvider, updateProvider } from "./ai.js";
import { onePageFile, onePageJob, startDocumentSummary, startOnePage } from "./onepage.js";
import { backfillRecords, fixMojibake, processDocument, recoverInterrupted, reindexDocument, removeDocument } from "./documents.js";
import { deleteNotebookVectors, deletePointVectors, indexSavedMessages, lastSyncReport, needsSync, reconcile, vectorModel } from "./indexing.js";
import * as qdrant from "./qdrant.js";
import { voiceRouter } from "./voice.js";

validateConfig();
const app = express(), upload = multer({ dest: uploadDir, limits: { fileSize: Number(process.env.MAX_FILE_SIZE_MB || 100) * 1024 * 1024, files: 50 } });
if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);
app.disable("x-powered-by");
// Só a página de embed pode ser colocada em iframe de outros sites; o restante do sistema continua protegido contra clickjacking.
app.use((req, res, next) => { res.set({ "x-content-type-options": "nosniff", "referrer-policy": "same-origin" }); if (req.path !== "/embed.html") res.set("x-frame-options", "DENY"); next(); });
app.use(express.json({ limit: "2mb" }));
const isPublicNotebook = (id: string) => !!db.prepare("SELECT 1 FROM notebooks WHERE id=? AND is_public=1").get(id);
// Saúde das dependências (sem dados sensíveis): SQLite, Qdrant (rede interna) e Ollama do Windows. Usado pelo healthcheck do Docker
// com ?live=1 (só o processo); sem o parâmetro, 503 se alguma dependência falhar.
app.get("/healthz", async (req, res) => {
  if (req.query.live === "1") return res.json({ ok: true });
  const sqlite = (() => { try { db.prepare("SELECT 1").get(); return true; } catch { return false; } })();
  const [vector, ollama] = await Promise.all([qdrant.ready(), ollamaStatus()]);
  const ok = sqlite && vector && ollama.ok;
  res.status(ok ? 200 : 503).json({ ok, sqlite, qdrant: vector, ollama: { ok: ollama.ok, ...(ollama.error ? { error: ollama.error } : {}) } });
});
// Autenticação e chat incorporável (embed): acessíveis sem login (as privadas exigem login).
app.post("/api/auth/login", login);
app.post("/api/auth/logout", logout);
app.get("/api/auth/me", (req, res) => currentUser(req) ? res.json({ ok: true }) : res.sendStatus(401));
app.get("/api/present/:id", (req, res) => {
  if (!currentUser(req) && !isPublicNotebook(req.params.id)) return res.sendStatus(401);
  const nb = db.prepare("SELECT name FROM notebooks WHERE id=?").get(req.params.id) as { name: string } | undefined;
  return nb ? res.json({ name: nb.name }) : res.sendStatus(404);
});
// O embed não grava nada no banco: o histórico fica no navegador (sessão web) e vem junto a cada pergunta.
app.post("/api/present/:id/ask", rateLimit("present-ask", Number(process.env.PRESENT_ASK_PER_MIN) || 20, 60_000), async (req, res) => {
  const nbId = String(req.params.id);
  if (!currentUser(req) && !isPublicNotebook(nbId)) return res.sendStatus(401);
  if (!existsNotebook(nbId)) return res.sendStatus(404);
  const question = String(req.body?.content || "").trim();
  if (!question || question.length > 5000) return res.status(400).json({ error: "Pergunta obrigatória (máximo de 5000 caracteres)." });
  const history = (Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [])
    .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m: any) => ({ role: m.role as string, content: m.content.slice(0, 4000) }));
  res.status(200).set({ "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" });
  res.flushHeaders();
  const send = (event: unknown) => res.write(JSON.stringify(event) + "\n");
  try {
    const result = await ask(nbId, question, { history, detailed: req.body?.detailed === true, onToken: token => send({ type: "token", token }) });
    send({ type: "done", assistant: { content: result.answer } });
  } catch (e) { send({ type: "error", error: e instanceof Error ? e.message : String(e) }); }
  res.end();
});
// Todo o resto da API exige login.
app.use("/api", (req, res, next) => {
  if (currentUser(req)) return next();
  res.status(401).json({ error: "Sessão expirada. Faça login novamente." });
});
const openPages = new Set(["/login.html", "/embed.html", "/favicon.svg", "/theme.js"]);
app.use((req, res, next) => {
  if (openPages.has(req.path) || currentUser(req)) return next();
  return req.path === "/" || req.path.endsWith(".html") ? res.redirect("/login.html") : res.sendStatus(401);
});
app.use(express.static(path.resolve("public")));
app.put("/api/notebooks/:id/public", (req, res) => {
  if (!existsNotebook(req.params.id)) return res.sendStatus(404);
  db.prepare("UPDATE notebooks SET is_public=? WHERE id=?").run(req.body?.public === true ? 1 : 0, req.params.id);
  res.json({ is_public: req.body?.public === true ? 1 : 0 });
});
const fail = (res: express.Response, e: unknown) => res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
const existsNotebook = (id: string) => !!db.prepare("SELECT 1 FROM notebooks WHERE id=?").get(id);
function fallbackConversationTitle(question: string) {
  const clean = question.replace(/\s+/g, " ").replace(/^[\s\p{P}]+/u, "").trim();
  if (clean.length <= 48) return clean || "Nova conversa";
  return `${clean.slice(0, 45).replace(/\s+\S*$/, "")}…`;
}
async function refineConversationTitle(id: string, question: string, answer: string, fallback: string) {
  try {
    const output = await chat({ temperature: 0.2, topP: 0.8, contextSize: chatContext(), maxTokens: 32, messages: [
      { role: "system", content: "Crie um título curto para esta conversa, no mesmo idioma da pergunta. Resuma o assunto em 2 a 6 palavras, no máximo 48 caracteres. Não use aspas, pontuação final nem frases como 'Conversa sobre'. Retorne somente o título." },
      { role: "user", content: `Pergunta: ${question}
Resposta: ${answer.slice(0, 1200)}` },
    ] });
    const generated = output.split(/\r?\n/)[0].replace(/^['"`#*\s]+|['"`#*\s]+$/g, "").replace(/^(título|title):\s*/i, "").trim();
    const title = generated ? generated.slice(0, 48).trim() : fallback;
    db.prepare("UPDATE conversations SET title=? WHERE id=? AND title=?").run(title, id, fallback);
  } catch (error) {
    console.warn("Falha ao gerar título da conversa:", error instanceof Error ? error.message : String(error));
  }
}
// Fila: cada conversa guarda no máximo MAX_MESSAGES_PER_CONVERSATION mensagens; as mais novas entram e as mais antigas saem.
// Mensagens salvas pelo usuário são preservadas (apagá-las removeria o item salvo).
const maxMessagesPerConversation = Math.max(10, Number(process.env.MAX_MESSAGES_PER_CONVERSATION) || 40);
function trimConversationQueue(id: string) {
  db.prepare("DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE conversation_id=? AND id NOT IN (SELECT message_id FROM saved_messages) ORDER BY created_at,rowid LIMIT MAX(0,(SELECT count(*) FROM messages WHERE conversation_id=?)-?))").run(id, id, maxMessagesPerConversation);
}
// Recupera de desligamentos: extração interrompida vira falha; indexação no Qdrant interrompida é retomada pela reconciliação.
recoverInterrupted();
// Documentos indexados antes dos registros estruturados ganham tabelas/fichas consultáveis sem reindexar embeddings.
setTimeout(() => { backfillRecords().catch(e => console.warn("Falha na migração de registros:", e)); }, 2_000);

app.get("/api/notebooks", (_req,res)=>res.json(db.prepare("SELECT n.*, (SELECT count(*) FROM documents d WHERE d.notebook_id=n.id) document_count FROM notebooks n ORDER BY created_at DESC").all()));
app.post("/api/notebooks", (req,res)=>{ const name=String(req.body?.name||"").trim(); if(!name||name.length>120)return res.status(400).json({error:"Nome obrigatório (até 120 caracteres)."}); const id=uuid(); db.prepare("INSERT INTO notebooks(id,name,description) VALUES(?,?,?)").run(id,name,String(req.body.description||"")); res.status(201).json(db.prepare("SELECT * FROM notebooks WHERE id=?").get(id)); });
app.patch("/api/notebooks/:id", (req,res)=>{ if(!existsNotebook(req.params.id))return res.sendStatus(404); const name=String(req.body?.name||"").trim(); if(!name||name.length>120)return res.status(400).json({error:"Nome obrigatório (até 120 caracteres)."}); db.prepare("UPDATE notebooks SET name=?,description=? WHERE id=?").run(name,String(req.body.description||""),req.params.id); res.json({ok:true}); });
app.delete("/api/notebooks/:id", async(req,res)=>{ const files=db.prepare("SELECT path FROM documents WHERE notebook_id=?").all(req.params.id) as {path:string|null}[]; if(!existsNotebook(req.params.id))return res.sendStatus(404); db.prepare("DELETE FROM notebooks WHERE id=?").run(req.params.id); for(const f of files)if(f.path)try{await fs.unlink(f.path)}catch{} await deleteNotebookVectors(req.params.id); res.json({ok:true}); });
app.get("/api/notebooks/:id/documents",(req,res)=>{ if(!existsNotebook(req.params.id))return res.sendStatus(404); const docs=db.prepare("SELECT id,name,type,status,error,progress,chunks_done,chunks_total,created_at FROM documents WHERE notebook_id=? ORDER BY created_at DESC").all(req.params.id) as any[]; res.json(docs.map(d=>({...d,name:fixMojibake(d.name)}))); });
app.post("/api/notebooks/:id/documents",upload.array("files",50),async(req,res)=>{ const notebookId=String(req.params.id),files=(req.files||[]) as Express.Multer.File[]; if(!existsNotebook(notebookId)){await Promise.all(files.map(f=>fs.unlink(f.path)));return res.sendStatus(404)} if(!files.length)return res.status(400).json({error:"Nenhum arquivo enviado."}); const accepted=files.map(file=>{const id=uuid(),name=fixMojibake(file.originalname);db.prepare("INSERT INTO documents(id,notebook_id,name,type,path) VALUES(?,?,?,?,?)").run(id,notebookId,name,path.extname(name).toLowerCase().slice(1),file.path);return {id,name,status:"processing"}});res.status(202).json({files:accepted});for(let i=0;i<files.length;i++)processDocument(accepted[i].id,notebookId,files[i].path,accepted[i].name).catch(e=>console.error("Processamento:",e)); });
app.post("/api/notebooks/:id/text",async(req,res)=>{ if(!existsNotebook(req.params.id))return res.sendStatus(404); const text=String(req.body?.text||"").trim(), name=String(req.body?.name||"Texto colado").trim(); if(!text||text.length>1_000_000)return res.status(400).json({error:"Texto obrigatório (máximo de 1 MB)."}); const id=uuid(); db.prepare("INSERT INTO documents(id,notebook_id,name,type,status) VALUES(?,?,?,'text','processing')").run(id,req.params.id,name); res.status(202).json({id,status:"processing"}); processDocument(id,req.params.id,null,name,text).catch(e=>console.error("Processamento:",e)); });
app.post("/api/documents/:id/reprocess",async(req,res)=>{ const d=db.prepare("SELECT * FROM documents WHERE id=?").get(req.params.id) as any; if(!d)return res.sendStatus(404); db.prepare("UPDATE documents SET status='processing',error=NULL WHERE id=?").run(d.id); res.status(202).json({status:"processing"}); processDocument(d.id,d.notebook_id,d.path,d.name).catch(e=>console.error("Reprocessamento:",e)); });
// Recalcula os embeddings de todo o notebook (documentos e mensagens salvas) com o modelo de embeddings atual.
const reindexing = new Set<string>();
app.post("/api/notebooks/:id/reindex",(req,res)=>{ const nb=String(req.params.id); if(!existsNotebook(nb))return res.sendStatus(404); if(reindexing.has(nb))return res.status(409).json({error:"A reindexação já está em andamento."});
  const ids=(db.prepare("SELECT DISTINCT d.id FROM documents d JOIN chunks c ON c.document_id=d.id WHERE d.notebook_id=? ORDER BY d.created_at").all(nb) as {id:string}[]).map(r=>r.id);
  ids.forEach(id=>db.prepare("UPDATE documents SET status='processing',progress=0,chunks_done=0,chunks_total=0,error=NULL WHERE id=?").run(id));
  db.prepare("UPDATE saved_messages SET indexed=0,index_error=NULL WHERE notebook_id=?").run(nb);
  reindexing.add(nb); res.status(202).json({documents:ids.length});
  void (async()=>{ for(const id of ids){ try{await reindexDocument(id)}catch(e){console.error("Reindexação:",e instanceof Error?e.message:String(e))} }
    try{await indexSavedMessages(nb,true)}catch(e){const msg=e instanceof Error?e.message:String(e);db.prepare("UPDATE saved_messages SET index_error=? WHERE notebook_id=? AND indexed=0").run(msg.slice(0,300),nb)}
    reindexing.delete(nb); })(); });
// Resumo "one page" de todos os documentos: geração em segundo plano (um resumo por documento), status e download do HTML.
app.post("/api/notebooks/:id/onepage",(req,res)=>{ const nb=String(req.params.id); if(!existsNotebook(nb))return res.sendStatus(404); if(onePageJob(nb)?.status==="running")return res.status(409).json({error:"A geração já está em andamento."}); const j=startOnePage(nb); res.status(202).json({status:j.status,total:j.total}); });
app.get("/api/notebooks/:id/onepage",(req,res)=>{ const nb=String(req.params.id); if(!existsNotebook(nb))return res.sendStatus(404); const j=onePageJob(nb); res.json(j?{status:j.status,done:j.done,total:j.total,error:j.error}:{status:"none"}); });
app.get("/api/notebooks/:id/onepage/download",(req,res)=>{ const nb=String(req.params.id); if(!existsNotebook(nb))return res.sendStatus(404); const name=(db.prepare("SELECT name FROM notebooks WHERE id=?").get(nb) as {name:string}).name.replace(/[^\w.-]+/g,"_").slice(0,60)||"notebook"; res.download(onePageFile(nb),`one-page-${name}.html`,e=>{ if(e&&!res.headersSent)res.status(404).json({error:"Nenhum resumo gerado ainda."}); }); });
// Resumo detalhado de um único documento (o texto inteiro, parte por parte): mesmo fluxo de geração, status e download.
app.post("/api/documents/:id/summary",(req,res)=>{ const id=String(req.params.id); if(!db.prepare("SELECT 1 FROM documents WHERE id=?").get(id))return res.sendStatus(404); if(onePageJob(`doc-${id}`)?.status==="running")return res.status(409).json({error:"A geração já está em andamento."}); const j=startDocumentSummary(id); res.status(202).json({status:j.status,total:j.total}); });
app.get("/api/documents/:id/summary",(req,res)=>{ const id=String(req.params.id); if(!db.prepare("SELECT 1 FROM documents WHERE id=?").get(id))return res.sendStatus(404); const j=onePageJob(`doc-${id}`); res.json(j?{status:j.status,done:j.done,total:j.total,error:j.error}:{status:"none"}); });
app.get("/api/documents/:id/summary/download",(req,res)=>{ const id=String(req.params.id),d=db.prepare("SELECT name FROM documents WHERE id=?").get(id) as {name:string}|undefined; if(!d)return res.sendStatus(404); res.download(onePageFile(`doc-${id}`),`resumo-${d.name.replace(/\.[^.]+$/,"").replace(/[^\w.-]+/g,"_").slice(0,60)||"documento"}.html`,e=>{ if(e&&!res.headersSent)res.status(404).json({error:"Nenhum resumo gerado ainda."}); }); });
app.delete("/api/documents/:id",async(req,res)=>{ try{const deleted=await removeDocument(req.params.id); return deleted?res.json({ok:true}):res.sendStatus(404)}catch(e){return fail(res,e)} });
app.get("/api/notebooks/:id/conversations",(req,res)=>{ if(!existsNotebook(req.params.id))return res.sendStatus(404); res.json(db.prepare("SELECT * FROM conversations WHERE notebook_id=? ORDER BY created_at DESC").all(req.params.id)); });
app.post("/api/notebooks/:id/conversations",(req,res)=>{ if(!existsNotebook(req.params.id))return res.sendStatus(404); const id=uuid(); db.prepare("INSERT INTO conversations(id,notebook_id,title) VALUES(?,?,?)").run(id,req.params.id,String(req.body?.title||"Nova conversa").slice(0,120)); db.prepare("DELETE FROM conversations WHERE notebook_id=? AND id NOT IN (SELECT id FROM conversations WHERE notebook_id=? ORDER BY created_at DESC,id DESC LIMIT 100)").run(req.params.id,req.params.id); res.status(201).json({id}); });
// Mensagens salvas da conversa saem junto (cascata no SQLite) e seus pontos saem do Qdrant.
app.delete("/api/conversations/:id",async(req,res)=>{ const saved=(db.prepare("SELECT s.id FROM saved_messages s JOIN messages m ON m.id=s.message_id WHERE m.conversation_id=?").all(req.params.id) as {id:string}[]).map(s=>s.id); const result=db.prepare("DELETE FROM conversations WHERE id=?").run(req.params.id); await deletePointVectors(saved); return result.changes?res.json({ok:true}):res.sendStatus(404); });
app.get("/api/notebooks/:id/saved-messages",(req,res)=>{ if(!existsNotebook(req.params.id))return res.sendStatus(404); res.json(db.prepare("SELECT s.id,s.title,s.created_at,m.id AS message_id,m.role,m.content,m.sources,s.indexed,s.index_error FROM saved_messages s JOIN messages m ON m.id=s.message_id WHERE s.notebook_id=? ORDER BY s.created_at DESC").all(req.params.id)); });
app.post("/api/notebooks/:id/saved-messages",(req,res)=>{ const notebookId=String(req.params.id),messageId=String(req.body?.messageId||""),title=String(req.body?.title||"").trim(); if(!existsNotebook(notebookId))return res.sendStatus(404); if(!title||title.length>120)return res.status(400).json({error:"Título obrigatório (até 120 caracteres)."}); const message=db.prepare("SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.notebook_id=?").get(messageId,notebookId); if(!message)return res.status(404).json({error:"Mensagem não encontrada neste notebook."}); const id=uuid(); try{db.prepare("INSERT INTO saved_messages(id,notebook_id,message_id,title) VALUES(?,?,?,?)").run(id,notebookId,messageId,title)}catch{return res.status(409).json({error:"Esta mensagem já está salva neste notebook."})} res.status(201).json({id}); indexSavedMessages(notebookId).catch(e=>{const msg=e instanceof Error?e.message:String(e);console.warn("Falha ao indexar mensagem salva (será tentado na próxima pergunta):",msg);db.prepare("UPDATE saved_messages SET index_error=? WHERE notebook_id=? AND indexed=0").run(msg.slice(0,300),notebookId)}); });
app.patch("/api/notebooks/:notebookId/saved-messages/:id",(req,res)=>{ const title=String(req.body?.title||"").trim(); if(!title||title.length>120)return res.status(400).json({error:"Título obrigatório (até 120 caracteres)."}); const result=db.prepare("UPDATE saved_messages SET title=? WHERE id=? AND notebook_id=?").run(title,req.params.id,req.params.notebookId); return result.changes?res.json({ok:true}):res.sendStatus(404); });
app.delete("/api/notebooks/:notebookId/saved-messages/:id",async(req,res)=>{ const result=db.prepare("DELETE FROM saved_messages WHERE id=? AND notebook_id=?").run(req.params.id,req.params.notebookId); if(result.changes)await deletePointVectors([req.params.id]); return result.changes?res.json({ok:true}):res.sendStatus(404); });
app.get("/api/conversations/:id/messages",(req,res)=>res.json(db.prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at").all(req.params.id)));
app.post("/api/conversations/:id/messages",async(req,res)=>{
  const conversation=db.prepare("SELECT * FROM conversations WHERE id=?").get(req.params.id) as {id:string;notebook_id:string;title:string}|undefined;
  if(!conversation)return res.sendStatus(404);
  const question=String(req.body?.content||"").trim();
  if(!question||question.length>5000)return res.status(400).json({error:"Pergunta obrigatória (máximo de 5000 caracteres)."});
  const stream=req.query.stream==="1",started=Date.now();let chunks=0,firstAt=0,lastAt=0;
  const send=(event:unknown)=>{ if(stream&&!res.destroyed)res.write(JSON.stringify(event)+"\n"); };
  // Cliente desconectado (botão parar): cancela a geração no provedor.
  const abort=new AbortController();res.on("close",()=>{if(!res.writableFinished)abort.abort()});
  try{
    const total=(db.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id=?").get(conversation.id) as {n:number}).n;
    // Últimas mensagens para todos os modelos: ask resolve perguntas de acompanhamento com elas (também no 1B/1.5B)
    // e decide pelo perfil se entram no prompt.
    const history=db.prepare("SELECT role,content FROM messages WHERE conversation_id=? ORDER BY created_at,rowid LIMIT 8 OFFSET ?").all(conversation.id,Math.max(0,total-8)) as {role:string;content:string}[];
    const createTitle=total===0&&conversation.title==="Nova conversa",fallback=createTitle?fallbackConversationTitle(question):"";
    const userId=uuid();
    db.prepare("INSERT INTO messages(id,conversation_id,role,content) VALUES(?,?,?,?)").run(userId,conversation.id,"user",question);
    if(stream){res.status(200).set({"content-type":"application/x-ndjson; charset=utf-8","cache-control":"no-cache","x-accel-buffering":"no"});res.flushHeaders();send({type:"user",id:userId});}
    const result=await ask(conversation.notebook_id,question,{signal:abort.signal,history,detailed:req.body?.detailed===true,creative:req.body?.creative===true,onToken:token=>{const t=Date.now();if(!chunks++)firstAt=t;lastAt=t;send({type:"token",token})},onSources:sources=>send({type:"sources",sources})});
    const id=uuid();
    const durationMs=Date.now()-started;
    // Aproximação: cada pedaço de streaming ≈ 1 token; respostas determinísticas (1 pedaço) não têm taxa.
    const tokensPerSec=chunks>=5&&lastAt>firstAt?Math.round((chunks-1)/((lastAt-firstAt)/1000)*10)/10:null;
    db.prepare("INSERT INTO messages(id,conversation_id,role,content,sources,duration_ms,tokens_per_sec) VALUES(?,?,?,?,?,?,?)").run(id,conversation.id,"assistant",result.answer,JSON.stringify(result.sources),durationMs,tokensPerSec);
    if(createTitle)db.prepare("UPDATE conversations SET title=? WHERE id=? AND title='Nova conversa'").run(fallback,conversation.id);
    const payload={user:{id:userId,role:"user",content:question},assistant:{id,role:"assistant",content:result.answer,sources:result.sources,duration_ms:durationMs,tokens_per_sec:tokensPerSec}};
    if(stream){send({type:"done",...payload});res.end();}else res.json(payload);
    if(createTitle)void refineConversationTitle(conversation.id,question,result.answer,fallback);
    trimConversationQueue(conversation.id);
  }catch(e){
    if(abort.signal.aborted)return;
    if(stream&&res.headersSent){send({type:"error",error:e instanceof Error?e.message:String(e)});res.end();}else fail(res,e);
  }
});
// Modo de voz (STT/TTS locais): só converte áudio <-> texto; a pergunta segue pelo endpoint de mensagens acima.
app.use("/api/voice",voiceRouter());
const aiError=(res:express.Response,e:unknown)=>res.status(400).json({error:e instanceof Error?e.message:String(e)});
app.get("/api/ai/kinds",(_req,res)=>res.json(providerKinds));
app.get("/api/ai/providers",(_req,res)=>res.json(listProviders()));
app.post("/api/ai/providers",(req,res)=>{try{res.status(201).json(createProvider(req.body))}catch(e){aiError(res,e)}});
app.put("/api/ai/providers/:id",(req,res)=>{try{const p=updateProvider(req.params.id,req.body);p?res.json(p):res.sendStatus(404)}catch(e){aiError(res,e)}});
app.delete("/api/ai/providers/:id",(req,res)=>deleteProvider(req.params.id)?res.json({ok:true}):res.sendStatus(404));
app.put("/api/ai/active",(req,res)=>{try{setActive({chat:req.body?.chat,embedding:req.body?.embedding});void tuneTarget().then(t=>autoTune(t)).catch(()=>{});res.json(listProviders().active)}catch(e){aiError(res,e)}});
app.get("/api/ai/status",(_req,res)=>res.json(activeSummary()));
app.post("/api/ai/providers/:id/test",async(req,res)=>{const p=getProvider(req.params.id);if(!p)return res.sendStatus(404);res.json(await testProvider(p))});
// Lista modelos do provedor; sem chave informada, usa a do provedor já cadastrado (providerId).
app.post("/api/ai/models",async(req,res)=>{try{const saved=getProvider(String(req.body?.providerId||""));const kind=req.body?.kind||saved?.kind;res.json({models:await listModels({kind,baseUrl:req.body?.baseUrl||saved?.baseUrl,apiKey:req.body?.apiKey||(saved&&saved.kind===kind?saved.apiKey:"")})})}catch(e){aiError(res,e)}});
app.get("/api/system/info",async(_req,res)=>{
  const dirSize=async(dir:string):Promise<number>=>{let total=0;for(const entry of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){const full=path.join(dir,entry.name);if(entry.isDirectory())total+=await dirSize(full);else if(entry.isFile())total+=(await fs.stat(full).catch(()=>({size:0}))).size}return total};
  const diskBytes=await Promise.all([dbPath,`${dbPath}-wal`,`${dbPath}-shm`].map(async file=>(await fs.stat(file).catch(()=>({size:0}))).size)).then(s=>s.reduce((a,b)=>a+b,0));
  const count=db.prepare("SELECT count(*) AS total, sum(CASE WHEN status='processed' THEN 1 ELSE 0 END) AS processed, sum(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM documents").get() as {total:number;processed:number|null;failed:number|null};
  const collection=await qdrant.getCollection().catch(()=>null);
  const vectorStore={url:config.qdrant.url,collection:config.qdrant.collection,status:collection?.status??"indisponível",points:collection?.points_count??null,embeddingModel:vectorModel()||null,lastSync:lastSyncReport()};
  res.json({vectorStore,supportedFormats:"PDF, DOCX, PPTX, XLSX, XLS, CSV, TXT, Markdown, JSON, JSONL, JavaScript, TypeScript, Python, Java, C/C++, CSS, HTML, XML, YAML, TOML, SQL, shell, logs e imagens PNG, JPG/JPEG, WebP, BMP, TIFF (OCR)",maxFileSizeMB:Number(process.env.MAX_FILE_SIZE_MB||100),maxFilesPerUpload:50,ocrLanguage:process.env.OCR_LANG||"por+eng",documents:{total:count.total,processed:count.processed||0,failed:count.failed||0},storage:{databaseBytes:diskBytes,uploadsBytes:await dirSize(uploadDir)},ai:activeSummary()});
});
// Reconciliação SQLite ↔ Qdrant: órfãos, divergências, indexações interrompidas e reconstrução do índice.
app.get("/api/system/sync",(_req,res)=>res.json(lastSyncReport()??{status:"none"}));
app.post("/api/system/sync",async(_req,res)=>res.json(await reconcile()));
app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{ if(err instanceof multer.MulterError)return res.status(400).json({error:err.message}); fail(res,err); });
const port=Number(process.env.PORT)||3000;
// Depois de subir: espera o Qdrant, confere o Ollama do Windows e reconcilia os bancos (com novas tentativas até dar certo).
async function startupChecks(){
  // Reranker local (Cross-Encoder ONNX): baixa/carrega em segundo plano; até ficar pronto, as perguntas seguem sem reranking.
  void prepareReranker();
  for(let i=0;!(await qdrant.ready());i++){ if(i%10===0)console.warn(`[Qdrant] aguardando ${config.qdrant.url}…`); await new Promise(r=>setTimeout(r,2_000)); }
  console.info(`[Qdrant] conectado a ${config.qdrant.url} (versão ${await qdrant.version()}), collection "${config.qdrant.collection}".`);
  const o=await ollamaStatus();
  if(o.ok)console.info(`[Ollama] ${o.baseUrl} acessível; modelos disponíveis: ${o.models?.join(", ")}.`); else console.error(`[Ollama] ${o.error}`);
  for(let delay=5_000;;delay=Math.min(delay*2,300_000)){
    const r=await reconcile();
    if(r.ok){ console.info(`[Sync] ${r.skipped?`ignorada: ${r.skipped}`:`ok · órfãos removidos ${r.orphanDocuments} doc(s)/${r.orphanPoints} ponto(s) · reparados ${r.repairedDocuments.length} · retomados ${r.resumedDocuments.length} · exclusões pendentes ${r.deferredDeletions} · incompatíveis ${r.incompatibleDocuments}`}`); break; }
    console.warn(`[Sync] falhou (${r.error}); nova tentativa em ${delay/1000}s.`); await new Promise(res=>setTimeout(res,delay));
  }
  // Depois: a cada SYNC_INTERVAL_MIN, retoma indexações que falharam (Ollama/Qdrant fora) e exclusões adiadas, se houver.
  const every=Math.max(1,Number(process.env.SYNC_INTERVAL_MIN)||5)*60_000;
  setInterval(()=>{ if(needsSync())void reconcile().then(r=>console.info(`[Sync] periódica: ${r.ok?`retomados ${r.resumedDocuments.length}, exclusões ${r.deferredDeletions}`:`falhou (${r.error})`}`)); },every).unref();
}
// Antes de aceitar conexões: mede o PC e pré-carrega os modelos (tuning.ts). A medição só acontece na 1ª vez por PC/modelo.
void tuneTarget().then(t=>autoTune(t)).catch(e=>console.warn("[Ajuste] falhou:",e)).finally(()=>app.listen(port,()=>{console.log(`Bento disponível em http://localhost:${port}`);void startupChecks().catch(e=>console.error("[Inicialização]",e));}));
