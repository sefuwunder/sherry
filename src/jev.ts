// sherry jev — a local Jev-style decision engine that learns from observed
// usage patterns. Zero deps, no cloud. It watches which kinds of suggestions
// the user acts on and re-ranks future suggestions accordingly.
//
// Model: per-kind Bernoulli with Laplace smoothing.
//   P(user acts | kind) = (acted + 1) / (shown + 2)
// Starts at 0.5 (maximum uncertainty), moves with evidence. All counts live
// in local SQLite; nothing leaves the machine.

import { getDb } from "./db";

export const SUGGEST_KINDS = [
  "waiting_reply",
  "overdue_task",
  "urgent_notif",
  "noisy_channel",
  "heavy_day",
  "pile_up",
] as const;
export type SuggestKind = (typeof SUGGEST_KINDS)[number];

export function ensureJevTables(): void {
  getDb().run(`CREATE TABLE IF NOT EXISTS jev_suggest_fb (
    kind TEXT PRIMARY KEY,
    shown INTEGER NOT NULL DEFAULT 0,
    acted INTEGER NOT NULL DEFAULT 0
  )`);
}

/** A suggestion of this kind was shown to the user. */
export function recordShown(kind: string): void {
  ensureJevTables();
  getDb()
    .query(
      "INSERT INTO jev_suggest_fb(kind, shown, acted) VALUES(?, 1, 0) " +
      "ON CONFLICT(kind) DO UPDATE SET shown = shown + 1"
    )
    .run(kind);
}

/** The user acted on a suggestion of this kind (ran the suggested command). */
export function recordActed(kind: string): void {
  ensureJevTables();
  getDb()
    .query(
      "INSERT INTO jev_suggest_fb(kind, shown, acted) VALUES(?, 1, 1) " +
      "ON CONFLICT(kind) DO UPDATE SET acted = acted + 1"
    )
    .run(kind);
}

export interface KindStats {
  kind: string;
  shown: number;
  acted: number;
  weight: number;
}

function statsFor(kind: string): { shown: number; acted: number } {
  ensureJevTables();
  const r = getDb()
    .query("SELECT shown, acted FROM jev_suggest_fb WHERE kind = ?")
    .get(kind) as { shown: number; acted: number } | null;
  return r || { shown: 0, acted: 0 };
}

/**
 * Laplace-smoothed P(user acts | kind). Starts at 0.5, learns over time.
 * Unknown kinds return 0.5 (no evidence either way).
 */
export function kindWeight(kind: string): number {
  const { shown, acted } = statsFor(kind);
  return (acted + 1) / (shown + 2);
}

/** Full learned ranking, most-trusted kind first. For transparency. */
export function learnedRanking(): KindStats[] {
  return SUGGEST_KINDS.map((kind) => {
    const { shown, acted } = statsFor(kind);
    return { kind, shown, acted, weight: (acted + 1) / (shown + 2) };
  }).sort((a, b) => b.weight - a.weight);
}

/** Human-readable summary of what the engine has learned. */
export function learnedSpeech(): string {
  const ranking = learnedRanking();
  const trained = ranking.filter((r) => r.shown > 0);
  if (!trained.length) {
    return "I haven't learned your patterns yet. Act on a few suggestions and I'll start prioritizing what you actually use.";
  }
  const top = ranking[0];
  const bottom = ranking[ranking.length - 1];
  const pretty: Record<string, string> = {
    waiting_reply: "replying to waiting messages",
    overdue_task: "tackling overdue tasks",
    urgent_notif: "urgent notifications",
    noisy_channel: "quieting noisy channels",
    heavy_day: "heavy-day warnings",
    pile_up: "project pile-up alerts",
  };
  const bits: string[] = [];
  if (top.shown >= 2) {
    bits.push(`you usually act when I suggest ${pretty[top.kind] || top.kind} (${top.acted} of ${top.shown} times)`);
  }
  if (bottom.shown >= 3 && bottom.weight < 0.4) {
    bits.push(`you tend to ignore ${pretty[bottom.kind] || bottom.kind}, so I mention those less`);
  }
  if (!bits.length) {
    return `I'm still learning — ${trained.length} suggestion ${trained.length === 1 ? "type" : "types"} seen so far.`;
  }
  return "What I've learned: " + bits.join(", and ") + ".";
}

/** Test hook: wipe learned counts. */
export function __resetJevForTests(): void {
  ensureJevTables();
  getDb().run("DELETE FROM jev_suggest_fb");
}
