import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { db, dbPath, uploadDir } from "./database.js";
import { ask, ensureSavedMessageEmbeddings, invalidateIndex, ollama, uuid } from "./rag.js";
import { fixMojibake, processDocument, removeDocument } from "./documents.js";

const app = express(), upload = multer({ dest: uploadDir, limits: { fileSize: Number(process.env.MAX_FILE_SIZE_MB || 100) * 1024 * 1024, files: 50 } });
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.resolve("public")));
const fail = (res: express.Response, e: unknown) => res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
const existsNotebook = (id: string) => !!db.prepare("SELECT 1 FROM notebooks WHERE id=?").get(id);
function fallbackConversationTitle(question: string) {
  const clean = question.replace(/\s+/g, " ").replace(/^[\s\p{P}]+/u, "").trim();
  if (clean.length <= 48) return clean || "Nova conversa";
  return `${clean.slice(0, 45).replace(/\s+\S*$/, "")}…`;
}
async function refineConversationTitle(id: string, question: string, answer: string, fallback: string) {
  try {
    const result = await ollama("/api/chat", {
      model: process.env.OLLAMA_CHAT_MODEL || "qwen2.5:1.5b-instruct",
      stream: false,
      keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m",
      options: { temperature: 0.2, top_p: 0.8, num_ctx: 2048, num_predict: 32 },
      messages: [
        { role: "system", content: "Crie um título curto para esta conversa, no mesmo idioma da pergunta. Resuma o assunto em 2 a 6 palavras, no máximo 48 caracteres. Não use aspas, pontuação final nem frases como 'Conversa sobre'. Retorne somente o título." },
        { role: "user", content: `Pergunta: ${question}\nResposta: ${answer.slice(0, 1200)}` },
      ],
    });
    const generated = String(result.message?.content || "").split(/\r?\n/)[0].replace(/^['"`#*\s]+|['"`#*\s]+$/g, "").replace(/^(título|title):\s*/i, "").trim();
    const title = generated ? generated.slice(0, 48).trim() : fallback;
    db.prepare("UPDATE conversations SET title=? WHERE id=? AND title=?").run(title, id, fallback);
  } catch (error) {
    console.warn("Falha ao gerar título da conversa:", error instanceof Error ? error.message : String(error));
  }
}
// Recupera de desligamentos enquanto um arquivo estava sendo indexado.
db.prepare("UPDATE documents SET status='failed',error='Processamento interrompido; clique em Reprocessar.' WHERE status='processing'").run();

app.get("/api/notebooks", (_req,res)=>res.json(db.prepare("SELECT n.*, (SELECT count(*) FROM documents d WHERE d.notebook_id=n.id) document_count FROM notebooks n ORDER BY created_at DESC").all()));
app.post("/api/notebooks", (req,res)=>{ const name=String(req.body?.name||"").trim(); if(!name||name.length>120)return res.status(400).json({error:"Nome obrigatório (até 120 caracteres)."}); const id=uuid(); db.prepare("INSERT INTO notebooks(id,name,description) VALUES(?,?,?)").run(id,name,String(req.body.description||"")); res.status(201).json(db.prepare("SELECT * FROM notebooks WHERE id=?").get(id)); });
app.patch("/api/notebooks/:id", (req,res)=>{ if(!existsNotebook(req.params.id))return res.sendStatus(404); const name=String(req.body?.name||"").trim(); if(!name||name.length>120)return res.status(400).json({error:"Nome obrigatório (até 120 caracteres)."}); db.prepare("UPDATE notebooks SET name=?,description=? WHERE id=?").run(name,String(req.body.description||""),req.params.id); res.json({ok:true}); });
app.delete("/api/notebooks/:id", async(req,res)=>{ const files=db.prepare("SELECT path FROM documents WHERE notebook_id=?").all(req.params.id) as {path:string|null}[]; if(!existsNotebook(req.params.id))return res.sendStatus(404); db.prepare("DELETE FROM notebooks WHERE id=?").run(req.params.id); for(const f of files)if(f.path)try{await fs.unlink(f.path)}catch{} res.json({ok:true}); });
app.get("/api/notebooks/:id/documents",(req,res)=>{ if(!existsNotebook(req.params.id))return res.sendStatus(404); const docs=db.prepare("SELECT id,name,type,status,error,progress,created_at FROM documents WHERE notebook_id=? ORDER BY created_at DESC").all(req.params.id) as any[]; res.json(docs.map(d=>({...d,name:fixMojibake(d.name)}))); });
app.post("/api/notebooks/:id/documents",upload.array("files",50),async(req,res)=>{ const notebookId=String(req.params.id),files=(req.files||[]) as Express.Multer.File[]; if(!existsNotebook(notebookId)){await Promise.all(files.map(f=>fs.unlink(f.path)));return res.sendStatus(404)} if(!files.length)return res.status(400).json({error:"Nenhum arquivo enviado."}); const accepted=files.map(file=>{const id=uuid(),name=fixMojibake(file.originalname);db.prepare("INSERT INTO documents(id,notebook_id,name,type,path) VALUES(?,?,?,?,?)").run(id,notebookId,name,path.extname(name).toLowerCase().slice(1),file.path);return {id,name,status:"processing"}});res.status(202).json({files:accepted});for(let i=0;i<files.length;i++)processDocument(accepted[i].id,notebookId,files[i].path,accepted[i].name).catch(e=>console.error("Processamento:",e)); });
app.post("/api/notebooks/:id/text",async(req,res)=>{ if(!existsNotebook(req.params.id))return res.sendStatus(404); const text=String(req.body?.text||"").trim(), name=String(req.body?.name||"Texto colado").trim(); if(!text||text.length>1_000_000)return res.status(400).json({error:"Texto obrigatório (máximo de 1 MB)."}); const id=uuid(); db.prepare("INSERT INTO documents(id,notebook_id,name,type,status) VALUES(?,?,?,'text','processing')").run(id,req.params.id,name); res.status(202).json({id,status:"processing"}); processDocument(id,req.params.id,null,name,text).catch(e=>console.error("Processamento:",e)); });
app.post("/api/documents/:id/reprocess",async(req,res)=>{ const d=db.prepare("SELECT * FROM documents WHERE id=?").get(req.params.id) as any; if(!d)return res.sendStatus(404); db.prepare("UPDATE documents SET status='processing',error=NULL WHERE id=?").run(d.id); res.status(202).json({status:"processing"}); processDocument(d.id,d.notebook_id,d.path,d.name).catch(e=>console.error("Reprocessamento:",e)); });
app.delete("/api/documents/:id",async(req,res)=>{ try{const deleted=await removeDocument(req.params.id); return deleted?res.json({ok:true}):res.sendStatus(404)}catch(e){return fail(res,e)} });
app.get("/api/notebooks/:id/conversations",(req,res)=>{ if(!existsNotebook(req.params.id))return res.sendStatus(404); res.json(db.prepare("SELECT * FROM conversations WHERE notebook_id=? ORDER BY created_at DESC").all(req.params.id)); });
app.post("/api/notebooks/:id/conversations",(req,res)=>{ if(!existsNotebook(req.params.id))return res.sendStatus(404); const id=uuid(); db.prepare("INSERT INTO conversations(id,notebook_id,title) VALUES(?,?,?)").run(id,req.params.id,String(req.body?.title||"Nova conversa").slice(0,120)); db.prepare("DELETE FROM conversations WHERE notebook_id=? AND id NOT IN (SELECT id FROM conversations WHERE notebook_id=? ORDER BY created_at DESC,id DESC LIMIT 100)").run(req.params.id,req.params.id); res.status(201).json({id}); });
app.delete("/api/conversations/:id",(req,res)=>{ const owner=db.prepare("SELECT notebook_id FROM conversations WHERE id=?").get(req.params.id) as {notebook_id:string}|undefined; const result=db.prepare("DELETE FROM conversations WHERE id=?").run(req.params.id); if(owner)invalidateIndex(owner.notebook_id); return result.changes?res.json({ok:true}):res.sendStatus(404); });
app.get("/api/notebooks/:id/saved-messages",(req,res)=>{ if(!existsNotebook(req.params.id))return res.sendStatus(404); res.json(db.prepare("SELECT s.id,s.title,s.created_at,m.id AS message_id,m.role,m.content,m.sources,(s.embedding IS NOT NULL) AS indexed,s.index_error FROM saved_messages s JOIN messages m ON m.id=s.message_id WHERE s.notebook_id=? ORDER BY s.created_at DESC").all(req.params.id)); });
app.post("/api/notebooks/:id/saved-messages",(req,res)=>{ const notebookId=String(req.params.id),messageId=String(req.body?.messageId||""),title=String(req.body?.title||"").trim(); if(!existsNotebook(notebookId))return res.sendStatus(404); if(!title||title.length>120)return res.status(400).json({error:"Título obrigatório (até 120 caracteres)."}); const message=db.prepare("SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.notebook_id=?").get(messageId,notebookId); if(!message)return res.status(404).json({error:"Mensagem não encontrada neste notebook."}); const id=uuid(); try{db.prepare("INSERT INTO saved_messages(id,notebook_id,message_id,title) VALUES(?,?,?,?)").run(id,notebookId,messageId,title)}catch{return res.status(409).json({error:"Esta mensagem já está salva neste notebook."})} invalidateIndex(notebookId); res.status(201).json({id}); db.prepare("UPDATE saved_messages SET index_error=NULL WHERE id=?").run(id); ensureSavedMessageEmbeddings(notebookId).catch(e=>{const msg=e instanceof Error?e.message:String(e);console.warn("Falha ao indexar mensagem salva (será tentado na próxima pergunta):",msg);db.prepare("UPDATE saved_messages SET index_error=? WHERE notebook_id=? AND embedding IS NULL").run(msg.slice(0,300),notebookId)}); });
app.patch("/api/notebooks/:notebookId/saved-messages/:id",(req,res)=>{ const title=String(req.body?.title||"").trim(); if(!title||title.length>120)return res.status(400).json({error:"Título obrigatório (até 120 caracteres)."}); const result=db.prepare("UPDATE saved_messages SET title=? WHERE id=? AND notebook_id=?").run(title,req.params.id,req.params.notebookId); return result.changes?res.json({ok:true}):res.sendStatus(404); });
app.delete("/api/notebooks/:notebookId/saved-messages/:id",(req,res)=>{ const result=db.prepare("DELETE FROM saved_messages WHERE id=? AND notebook_id=?").run(req.params.id,req.params.notebookId); invalidateIndex(req.params.notebookId); return result.changes?res.json({ok:true}):res.sendStatus(404); });
app.get("/api/conversations/:id/messages",(req,res)=>res.json(db.prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at").all(req.params.id)));
app.post("/api/conversations/:id/messages",async(req,res)=>{
  const conversation=db.prepare("SELECT * FROM conversations WHERE id=?").get(req.params.id) as {id:string;notebook_id:string;title:string}|undefined;
  if(!conversation)return res.sendStatus(404);
  const question=String(req.body?.content||"").trim();
  if(!question||question.length>5000)return res.status(400).json({error:"Pergunta obrigatória (máximo de 5000 caracteres)."});
  const stream=req.query.stream==="1",started=Date.now();
  const send=(event:unknown)=>{ if(stream)res.write(JSON.stringify(event)+"\n"); };
  try{
    const history=(db.prepare("SELECT role,content FROM (SELECT role,content,created_at,rowid FROM messages WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 4) ORDER BY created_at,rowid").all(conversation.id) as {role:string;content:string}[]);
    const createTitle=history.length===0&&conversation.title==="Nova conversa",fallback=createTitle?fallbackConversationTitle(question):"";
    const userId=uuid();
    db.prepare("INSERT INTO messages(id,conversation_id,role,content) VALUES(?,?,?,?)").run(userId,conversation.id,"user",question);
    if(stream){res.status(200).set({"content-type":"application/x-ndjson; charset=utf-8","cache-control":"no-cache","x-accel-buffering":"no"});res.flushHeaders();send({type:"user",id:userId});}
    const result=await ask(conversation.notebook_id,question,{history,onToken:token=>send({type:"token",token}),onSources:sources=>send({type:"sources",sources})});
    const id=uuid();
    const durationMs=Date.now()-started;
    db.prepare("INSERT INTO messages(id,conversation_id,role,content,sources,duration_ms) VALUES(?,?,?,?,?,?)").run(id,conversation.id,"assistant",result.answer,JSON.stringify(result.sources),durationMs);
    if(createTitle)db.prepare("UPDATE conversations SET title=? WHERE id=? AND title='Nova conversa'").run(fallback,conversation.id);
    const payload={user:{id:userId,role:"user",content:question},assistant:{id,role:"assistant",content:result.answer,sources:result.sources,duration_ms:durationMs}};
    if(stream){send({type:"done",...payload});res.end();}else res.json(payload);
    if(createTitle)void refineConversationTitle(conversation.id,question,result.answer,fallback);
  }catch(e){
    if(stream&&res.headersSent){send({type:"error",error:e instanceof Error?e.message:String(e)});res.end();}else fail(res,e);
  }
});
app.get("/api/health/ollama",async(_req,res)=>{try{const data=await ollama("/api/tags");res.json({ok:true,models:data.models?.map((m:any)=>m.name)||[]})}catch(e){res.status(503).json({ok:false,error:e instanceof Error?e.message:String(e)})}});
app.get("/api/system/info",async(_req,res)=>{
  const dirSize=async(dir:string):Promise<number>=>{let total=0;for(const entry of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){const full=path.join(dir,entry.name);if(entry.isDirectory())total+=await dirSize(full);else if(entry.isFile())total+=(await fs.stat(full).catch(()=>({size:0}))).size}return total};
  const diskBytes=await Promise.all([dbPath,`${dbPath}-wal`,`${dbPath}-shm`].map(async file=>(await fs.stat(file).catch(()=>({size:0}))).size)).then(s=>s.reduce((a,b)=>a+b,0));
  const count=db.prepare("SELECT count(*) AS total, sum(CASE WHEN status='processed' THEN 1 ELSE 0 END) AS processed, sum(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM documents").get() as {total:number;processed:number|null;failed:number|null};
  let ollamaStatus:{ok:boolean;models:string[];error?:string};try{const tags=await ollama("/api/tags");ollamaStatus={ok:true,models:(tags.models||[]).map((m:any)=>m.name)}}catch(e){ollamaStatus={ok:false,models:[],error:e instanceof Error?e.message:String(e)}}
  res.json({supportedFormats:"PDF, DOCX, PPTX, XLSX, XLS, CSV, TXT, Markdown, JSON, JSONL, JavaScript, TypeScript, Python, Java, C/C++, CSS, HTML, XML, YAML, TOML, SQL, shell, logs e imagens PNG, JPG/JPEG, WebP, BMP, TIFF (OCR)",maxFileSizeMB:Number(process.env.MAX_FILE_SIZE_MB||100),maxFilesPerUpload:50,ocrLanguage:process.env.OCR_LANG||"por+eng",documents:{total:count.total,processed:count.processed||0,failed:count.failed||0},storage:{databaseBytes:diskBytes,uploadsBytes:await dirSize(uploadDir)},ollama:ollamaStatus,configuredModels:{chat:process.env.OLLAMA_CHAT_MODEL||"qwen2.5:1.5b-instruct",embedding:process.env.OLLAMA_EMBEDDING_MODEL||"bge-m3"}});
});
app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{ if(err instanceof multer.MulterError)return res.status(400).json({error:err.message}); fail(res,err); });
const port=Number(process.env.PORT)||3000;
app.listen(port,()=>console.log(`RAG Local disponível em http://localhost:${port}`));
