// sherry: deterministic cross-app analyzer. Reads Relay, Ascent, and
// Switchboard, then produces prioritized spoken suggestions. Ranking blends
// static urgency with the Jev engine's learned per-kind weights, so
// suggestions the user acts on rise over time. No LLM.

import { bases, get } from "./clients";
import { kindWeight, recordShown, type SuggestKind } from "./jev";

export interface Suggestion {
  kind: SuggestKind;
  priority: number; // lower = more urgent (static urgency)
  text: string;
  action?: string; // spoken follow-up, e.g. "say 'mute github' to quiet it"
  /** Machine-readable match for feedback: what user command counts as acting. */
  match?: { type: "mute"; label: string } | { type: "message"; contact: string } | { type: "myday" };
}

interface RelayConv {
  id: string; title: string; unread?: number;
  last_direction?: string; last_at?: string; last_body?: string;
  is_group?: boolean;
}

interface AscentTask {
  title?: string; name?: string; due_date?: string; project_name?: string;
}

interface SwNotif {
  id: number; title?: string; body?: string;
  channel_id?: string; channel?: string;
  priority?: string; status?: string; created_at?: number;
}

interface SwChannel {
  id: string; label?: string; mode?: string; enabled?: number;
}

function hoursSince(iso?: string): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return Infinity;
  return (Date.now() - t) / 3600_000;
}

function taskTitle(t: AscentTask): string {
  return String(t.title || t.name || "untitled").slice(0, 80);
}

/** Analyze Relay conversations: unanswered inbound, stale threads, neglected contacts. */
export function analyzeRelay(convs: RelayConv[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const c of convs) {
    const unread = c.unread || 0;
    const inbound = (c.last_direction || "") === "in";
    const ageH = hoursSince(c.last_at);
    if (unread > 0 && inbound && ageH >= 3) {
      const when = ageH >= 24
        ? `${Math.round(ageH / 24)} day${Math.round(ageH / 24) === 1 ? "" : "s"}`
        : `${Math.round(ageH)} hours`;
      out.push({
        kind: "waiting_reply",
        priority: 2,
        text: `${c.title} has been waiting ${when} for a reply${unread > 1 ? ` (${unread} unread)` : ""}`,
        action: `say "message ${c.title.toLowerCase()} ..." to reply`,
        match: { type: "message", contact: c.title.toLowerCase() },
      });
    }
    // Neglected: no contact in 14+ days (lightweight, from last_at alone).
    // Skip groups and conversations that never had real exchange.
    const ageD = ageH / 24;
    if (!c.is_group && ageD >= 14 && ageD < 365) {
      out.push({
        kind: "neglected_contact",
        priority: 8,
        text: `You haven't talked to ${c.title} in ${Math.round(ageD)} days`,
        action: `say "message ${c.title.toLowerCase()} ..." to check in`,
        match: { type: "message", contact: c.title.toLowerCase() },
      });
    }
  }
  return out;
}

/** Analyze Ascent tasks: overdue first, then today's load, then pile-ups. */
export function analyzeAscent(myday: any): Suggestion[] {
  const out: Suggestion[] = [];
  const overdue: AscentTask[] = myday?.overdue || [];
  const today: AscentTask[] = myday?.today || [];
  if (overdue.length) {
    const first = taskTitle(overdue[0]);
    out.push({
      kind: "overdue_task",
      priority: 3,
      text: `${overdue.length} overdue task${overdue.length === 1 ? "" : "s"}. Oldest: ${first}`,
      action: `say "what's on my plate" to hear them all`,
      match: { type: "myday" },
    });
  }
  if (today.length >= 5) {
    out.push({
      kind: "heavy_day",
      priority: 5,
      text: `${today.length} tasks due today — that's a heavy day. Consider pushing the least urgent`,
    });
  }
  // Pile-up: one project holding a disproportionate share of open work.
  const byProject = new Map<string, number>();
  for (const t of [...overdue, ...today, ...(myday?.in_progress || [])]) {
    const p = String(t.project_name || "untagged");
    byProject.set(p, (byProject.get(p) || 0) + 1);
  }
  if (byProject.size > 1) {
    const top = [...byProject.entries()].sort((a, b) => b[1] - a[1])[0];
    const total = [...byProject.values()].reduce((n, x) => n + x, 0);
    if (top[1] >= 3 && top[1] / total >= 0.6) {
      out.push({
        kind: "pile_up",
        priority: 6,
        text: `${top[1]} of your ${total} open tasks are in ${top[0]} — it might deserve a focused block`,
      });
    }
  }
  return out;
}

/** Analyze Switchboard: urgent items, noisy channels worth muting. */
export function analyzeSwitchboard(notifs: SwNotif[], channels: SwChannel[]): Suggestion[] {
  const out: Suggestion[] = [];
  const active = notifs.filter((n) => n.status !== "dismissed" && n.status !== "snoozed");
  const urgent = active.filter((n) => (n.priority || "normal") === "urgent").slice(0, 3);
  for (const u of urgent) {
    out.push({
      kind: "urgent_notif",
      priority: 1,
      text: `Urgent: ${String(u.title || "notification").slice(0, 100)}`,
    });
  }
  // Noisy channel: 6+ notifications from one channel in the window.
  const byChannel = new Map<string, number>();
  for (const n of active) {
    const cid = n.channel_id || n.channel || "";
    if (!cid) continue;
    byChannel.set(cid, (byChannel.get(cid) || 0) + 1);
  }
  const labels = new Map(channels.map((c) => [c.id, c.label || c.id]));
  for (const [cid, count] of byChannel) {
    if (count >= 6) {
      const label = labels.get(cid) || cid;
      out.push({
        kind: "noisy_channel",
        priority: 7,
        text: `${label} sent ${count} notifications lately and none were urgent`,
        action: `say "mute ${label.toLowerCase()}" to quiet it`,
        match: { type: "mute", label: label.toLowerCase() },
      });
      break; // one noise suggestion per run is enough
    }
  }
  return out;
}

/** Cross-app: suggest a triage order when several things compete. */
function triageOrder(suggestions: Suggestion[]): Suggestion | null {
  const hasUrgent = suggestions.some((s) => s.priority === 1);
  const waiting = suggestions.filter((s) => s.priority === 2).length;
  const overdue = suggestions.filter((s) => s.priority === 3).length;
  if ((hasUrgent ? 1 : 0) + waiting + overdue >= 2) {
    const bits: string[] = [];
    if (hasUrgent) bits.push("the urgent notification");
    if (waiting) bits.push(`${waiting} waiting ${waiting === 1 ? "reply" : "replies"}`);
    if (overdue) bits.push("the overdue tasks");
    return {
      priority: 0,
      text: `Suggested order: ${bits.join(", then ")}`,
    };
  }
  return null;
}

export interface AnalyzeResult {
  speech: string;
  ok: boolean;
  /** Suggestions actually spoken, for the feedback loop. */
  offered: Array<{ kind: SuggestKind; match?: Suggestion["match"] }>;
}

/**
 * Learned score: static urgency blended with the Jev engine's per-kind
 * weight. Urgency dominates early (all weights start at 0.5); as evidence
 * accumulates, kinds the user acts on rise and ignored kinds sink.
 */
function learnedScore(s: Suggestion): number {
  return s.priority * (1.5 - kindWeight(s.kind));
}

export async function analyze(): Promise<AnalyzeResult> {
  const b = bases();
  const [relayR, ascentR, notifR, chanR] = await Promise.all([
    get(b.relay, "/api/conversations"),
    get(b.ascent, "/api/myday"),
    get(b.switchboard, "/api/notifications?limit=30"),
    get(b.switchboard, "/api/channels"),
  ]);

  const suggestions: Suggestion[] = [];
  const unreachable: string[] = [];

  if (relayR.ok) {
    suggestions.push(...analyzeRelay(relayR.data?.conversations || []));
  } else unreachable.push("Relay");

  if (ascentR.ok) {
    suggestions.push(...analyzeAscent(ascentR.data || {}));
  } else unreachable.push("Ascent");

  if (notifR.ok) {
    const channels: SwChannel[] = chanR.ok ? chanR.data?.channels || [] : [];
    suggestions.push(...analyzeSwitchboard(notifR.data?.notifications || [], channels));
  } else unreachable.push("Switchboard");

  if (!suggestions.length) {
    if (unreachable.length === 3) {
      return { ok: false, speech: "I can't reach Relay, Ascent, or Switchboard. Are they running?", offered: [] };
    }
    const extra = unreachable.length ? ` (Couldn't reach ${unreachable.join(" and ")}.)` : "";
    return { ok: true, speech: `All clear. Nothing needs your attention right now.${extra}`, offered: [] };
  }

  suggestions.sort((a, z) => learnedScore(a) - learnedScore(z));
  const triage = triageOrder(suggestions);
  const top = suggestions.slice(0, 4);
  const lines = top.map((s) => s.text + ".");
  if (triage) lines.unshift(triage.text + ".");
  const actions = top.map((s) => s.action).filter(Boolean).slice(0, 2);
  if (actions.length) lines.push(actions.join(". ") + ".");

  let speech = lines.join(" ");
  if (unreachable.length) speech += ` Couldn't reach ${unreachable.join(" and ")}.`;

  // Feedback loop: record what was shown so acting on it later counts.
  const offered = top.map((s) => ({ kind: s.kind, match: s.match }));
  for (const o of offered) recordShown(o.kind);
  return { ok: true, speech, offered };
}
