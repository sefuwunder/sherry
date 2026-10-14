// sherry: reminders & timers. Natural-language time parsing ("in 20 minutes",
// "at 3pm", "tomorrow at 9am"), SQLite persistence, and a watcher that fires
// due reminders over SSE so the widget speaks them. Zero deps.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dataDir } from "./db";

export interface Reminder {
  id: number;
  text: string;
  fireAtMs: number;
  kind: "reminder" | "timer";
  fired: number;
  createdAtMs: number;
}

function db() {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const d = new Database(dir + "/sherry.db");
  d.exec(`CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    fire_at_ms INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'reminder',
    fired INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (fired, fire_at_ms)`);
  return d;
}

const MIN = 60_000;
const HOUR = 3_600_000;

function parseClock(s: string, baseMs: number): number | null {
  // "3pm", "3:30pm", "15:30", "3 pm"
  const m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = (m[3] || "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  const d = new Date(baseMs);
  d.setHours(h, min, 0, 0);
  let t = d.getTime();
  // If the time already passed today, assume tomorrow.
  if (t <= baseMs) t += 86_400_000;
  return t;
}

/**
 * Parse a time expression out of free text. Returns { fireAtMs, text } where
 * text is the remainder after removing the time expression.
 */
export function parseTimeSpec(input: string, nowMs = Date.now()): { fireAtMs: number; text: string } | null {
  const t = input.trim();

  // Bare duration ("10 minutes", "an hour") — used by the timer intent after
  // the router strips "set a timer for".
  let m = t.match(/^(?:a|an)\s+(minute|hour|second)s?\b/i);
  if (m) {
    const unit = m[1].toLowerCase();
    const ms = unit.startsWith("minute") ? MIN : unit.startsWith("hour") ? HOUR : 1000;
    return { fireAtMs: nowMs + ms, text: t.replace(m[0], "").trim() };
  }
  m = t.match(/^(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i);
  if (m) {
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    const ms = u.startsWith("s") ? 1000 : u.startsWith("m") ? MIN : HOUR;
    if (n <= 0 || n > 24 * 7) return null;
    return { fireAtMs: nowMs + Math.round(n * ms), text: t.replace(m[0], "").trim() };
  }

  // "in 20 minutes" / "in 2 hours" / "in 30 seconds" / "in a minute"
  m = t.match(/\bin\s+(?:a|an)\s+(minute|hour|second)\b/i);
  if (m) {
    const unit = m[1].toLowerCase();
    const ms = unit.startsWith("minute") ? MIN : unit.startsWith("hour") ? HOUR : 1000;
    return { fireAtMs: nowMs + ms, text: t.replace(m[0], "").trim() };
  }
  m = t.match(/\bin\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i);
  if (m) {
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    const ms = u.startsWith("s") ? 1000 : u.startsWith("m") ? MIN : HOUR;
    if (n <= 0 || n > 24 * 7) return null;
    return { fireAtMs: nowMs + Math.round(n * ms), text: t.replace(m[0], "").trim() };
  }

  // "tomorrow at 9am" / "tomorrow morning"
  m = t.match(/\btomorrow\b/i);
  if (m) {
    const rest = t.replace(m[0], "");
    const clock = parseClock(rest, nowMs + 86_400_000);
    if (clock) {
      const cleaned = rest.replace(/\bat\b\s*\d{1,2}(?::\d{2})?\s*(am|pm)?/i, "").trim();
      return { fireAtMs: clock, text: (t.replace(/\btomorrow\b/i, "").replace(/\bat\b\s*\d{1,2}(?::\d{2})?\s*(am|pm)?/i, "")).trim() || cleaned };
    }
    // "tomorrow" alone -> 9am tomorrow
    const d = new Date(nowMs + 86_400_000);
    d.setHours(9, 0, 0, 0);
    return { fireAtMs: d.getTime(), text: t.replace(m[0], "").trim() };
  }

  // "at 3pm" / "at 15:30"
  m = t.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i);
  if (m) {
    const clock = parseClock(m[1], nowMs);
    if (clock) {
      return { fireAtMs: clock, text: t.replace(m[0], "").trim() };
    }
  }

  return null;
}

export function addReminder(text: string, fireAtMs: number, kind: "reminder" | "timer" = "reminder"): Reminder {
  const d = db();
  const clean = text.replace(/^(to|that|about)\s+/i, "").trim() || (kind === "timer" ? "Timer" : "Reminder");
  const r = d.query(
    `INSERT INTO reminders (text, fire_at_ms, kind, created_at_ms) VALUES (?, ?, ?, ?)`
  ).run(clean, fireAtMs, kind, Date.now());
  const row = d.query(`SELECT * FROM reminders WHERE id = ?`).get(Number(r.lastInsertRowid)) as any;
  d.close();
  return rowToReminder(row);
}

function rowToReminder(r: any): Reminder {
  return {
    id: r.id, text: r.text, fireAtMs: r.fire_at_ms,
    kind: r.kind, fired: r.fired, createdAtMs: r.created_at_ms,
  };
}

/** Return due reminders and mark them fired. */
export function popDue(nowMs = Date.now()): Reminder[] {
  const d = db();
  const rows = d.query(`SELECT * FROM reminders WHERE fired = 0 AND fire_at_ms <= ? ORDER BY fire_at_ms`).all(nowMs) as any[];
  if (rows.length) {
    d.query(`UPDATE reminders SET fired = 1 WHERE fired = 0 AND fire_at_ms <= ?`).run(nowMs);
  }
  d.close();
  return rows.map(rowToReminder);
}

export function listPending(): Reminder[] {
  const d = db();
  const rows = d.query(`SELECT * FROM reminders WHERE fired = 0 ORDER BY fire_at_ms`).all() as any[];
  d.close();
  return rows.map(rowToReminder);
}

export function cancelAll(): number {
  const d = db();
  const r = d.query(`UPDATE reminders SET fired = 2 WHERE fired = 0`).run();
  d.close();
  return Number(r.changes || 0);
}

export function clearFired(): void {
  const d = db();
  d.query(`DELETE FROM reminders WHERE fired != 0`).run();
  d.close();
}

/** Human-friendly "in 20 minutes" / "at 3pm" for confirmations. */
export function fmtWhen(fireAtMs: number, nowMs = Date.now()): string {
  const diff = fireAtMs - nowMs;
  if (diff < 90_000) return "in a minute";
  if (diff < HOUR) return `in ${Math.round(diff / MIN)} minutes`;
  if (diff < 24 * HOUR) {
    const h = Math.floor(diff / HOUR);
    const m = Math.round((diff % HOUR) / MIN);
    return m ? `in ${h} hour${h === 1 ? "" : "s"} ${m} minutes` : `in ${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = new Date(fireAtMs);
  const today = new Date(nowMs);
  const isTmr = d.toDateString() === new Date(nowMs + 86_400_000).toDateString();
  let h = d.getHours();
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  const mm = d.getMinutes() ? `:${String(d.getMinutes()).padStart(2, "0")}` : "";
  return isTmr ? `tomorrow at ${h}${mm}${ap}` : `at ${h}${mm}${ap}`;
}
