// sherry: SQLite store for the hear log (utterance -> intent -> spoken reply).
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function dataDir(): string {
  return process.env.SHERRY_DATA || join(process.cwd(), "data");
}

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  db = new Database(join(dir, "sherry.db"));
  db.run(`CREATE TABLE IF NOT EXISTS hear_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transcript TEXT NOT NULL,
    intent TEXT NOT NULL DEFAULT 'unknown',
    speech TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`);
  return db;
}

/** Test hook: reset the singleton so tests can point at a temp dir. */
export function __resetDbForTests(): void {
  if (db) {
    try { db.close(); } catch { /* noop */ }
  }
  db = null;
}

export interface HearEntry {
  id: number;
  transcript: string;
  intent: string;
  speech: string;
  created_at: number;
}

export function logHear(transcript: string, intent: string, speech: string): HearEntry {
  const d = getDb();
  const now = Date.now();
  const r = d.run("INSERT INTO hear_log (transcript, intent, speech, created_at) VALUES (?, ?, ?, ?)",
    [transcript, intent, speech, now]);
  return { id: Number(r.lastInsertRowid), transcript, intent, speech, created_at: now };
}

export function recentHear(limit = 20): HearEntry[] {
  return getDb()
    .query("SELECT * FROM hear_log ORDER BY id DESC LIMIT ?")
    .all(Math.max(1, Math.min(100, limit))) as HearEntry[];
}
