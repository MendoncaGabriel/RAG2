import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

// SQLite: fonte de verdade de textos, metadados, relacionamentos, conversas e estado de indexação.
// Não guarda embeddings nem faz busca vetorial: isso é do Qdrant (qdrant.ts / indexing.ts).
export const dbPath = config.sqlitePath;
export const uploadDir = config.uploadDir;
export const dataDir = config.dataDir;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });
export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");
db.exec(`
CREATE TABLE IF NOT EXISTS notebooks(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', is_public INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
-- status: processing | processed | failed (contrato da interface)
-- stage: extract (lendo o arquivo) | index (trechos no SQLite, vetores pendentes no Qdrant) | done
-- embedding_model: modelo que gerou os vetores no Qdrant (busca recusa misturar modelos)
CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT NOT NULL, path TEXT,
  status TEXT NOT NULL DEFAULT 'processing', stage TEXT NOT NULL DEFAULT 'extract', error TEXT, progress REAL NOT NULL DEFAULT 0, chunks_done INTEGER NOT NULL DEFAULT 0, chunks_total INTEGER NOT NULL DEFAULT 0,
  source_text TEXT, chunk_version INTEGER NOT NULL DEFAULT 0, records_version INTEGER NOT NULL DEFAULT 0, embedding_model TEXT, indexed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS documents_notebook ON documents(notebook_id, status);
-- id do trecho = id do ponto no Qdrant (UUID determinístico por documento + posição: reprocessar sobrescreve, não duplica).
-- indexed: 1 quando o ponto correspondente foi gravado no Qdrant (permite retomar a indexação sem refazer o que já foi).
CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL, content TEXT NOT NULL, search_text TEXT NOT NULL, section TEXT, page_start INTEGER, page_end INTEGER, toc INTEGER NOT NULL DEFAULT 0, indexed INTEGER NOT NULL DEFAULT 0,
  UNIQUE(document_id, chunk_index));
CREATE INDEX IF NOT EXISTS chunks_notebook ON chunks(notebook_id);
CREATE INDEX IF NOT EXISTS chunks_pending ON chunks(document_id, indexed);
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE, title TEXT NOT NULL DEFAULT 'Nova conversa', summary TEXT NOT NULL DEFAULT '', summary_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS conversations_notebook ON conversations(notebook_id);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]', duration_ms INTEGER, tokens_per_sec REAL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at);
-- Mensagens salvas também entram na busca: o vetor fica no Qdrant (ponto com o id da linha), o texto aqui.
CREATE TABLE IF NOT EXISTS saved_messages(id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE, message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE, title TEXT NOT NULL,
  indexed INTEGER NOT NULL DEFAULT 0, embedding_model TEXT, index_error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
-- Registros estruturados (linhas de tabelas e fichas) para filtros, contagens e cálculos determinísticos.
CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE, table_key TEXT NOT NULL, title TEXT NOT NULL, headers TEXT NOT NULL, fields TEXT NOT NULL, row_index INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS records_notebook ON records(notebook_id);
CREATE INDEX IF NOT EXISTS records_document ON records(document_id);
-- Pontos do Qdrant cuja exclusão falhou (Qdrant fora do ar): a reconciliação tenta de novo.
CREATE TABLE IF NOT EXISTS vector_deletions(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
`);
// Bancos da versão anterior (embeddings em BLOB no SQLite) não são migrados: a arquitetura exige reindexar no Qdrant.
if ((db.prepare("SELECT count(*) AS n FROM pragma_table_info('chunks') WHERE name='embedding'").get() as { n: number }).n)
  throw new Error(`O banco ${dbPath} é da versão anterior (vetores no SQLite). Aponte SQLITE_PATH para um arquivo novo; os documentos precisam ser enviados de novo.`);
db.exec("PRAGMA user_version = 3");

// Executa fn numa transação (BEGIN IMMEDIATE evita disputa de escrita entre requisições).
export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const out = fn(); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; }
}
