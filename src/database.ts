import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const dbPath = path.resolve(process.env.DATABASE_PATH || "./data/database.sqlite");
export const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./data/uploads");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });
export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS notebooks(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT NOT NULL, path TEXT, status TEXT NOT NULL DEFAULT 'processing', error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE, content TEXT NOT NULL, embedding BLOB NOT NULL, dimensions INTEGER NOT NULL, chunk_index INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS chunks_notebook ON chunks(notebook_id);
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE, title TEXT NOT NULL DEFAULT 'Nova conversa', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS saved_messages(id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE, message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE, title TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
`);
try { db.exec("ALTER TABLE documents ADD COLUMN progress INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE saved_messages ADD COLUMN embedding BLOB"); } catch {}
try { db.exec("ALTER TABLE saved_messages ADD COLUMN dimensions INTEGER"); } catch {}
try { db.exec("ALTER TABLE saved_messages ADD COLUMN index_error TEXT"); } catch {}
try { db.exec("ALTER TABLE messages ADD COLUMN duration_ms INTEGER"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN summary TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN summary_count INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE notebooks ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0"); } catch {}
