// sherry: HTTP clients for the four plugged-in apps.
// Every app is optional: base URLs come from env with localhost defaults,
// and every call degrades to { ok: false, error } on timeout/refusal.
// No secrets are read here — these are all unauthenticated localhost APIs.
const TIMEOUT = 10_000;

export function bases() {
  return {
    briefing: (process.env.BRIEFING_URL || "http://127.0.0.1:3000").replace(/\/$/, ""),
    ascent: (process.env.ASCENT_URL || "http://127.0.0.1:3004").replace(/\/$/, ""),
    relay: (process.env.RELAY_URL || "http://127.0.0.1:3006").replace(/\/$/, ""),
    switchboard: (process.env.SWITCHBOARD_URL || "http://127.0.0.1:3002").replace(/\/$/, ""),
    // NOTE: longview and idea-party both default to :3011 upstream — if you
    // run both, put one on another port and point LONGVIEW_URL at longview.
    longview: (process.env.LONGVIEW_URL || "http://127.0.0.1:3011").replace(/\/$/, ""),
  };
}

async function get(base: string, path: string): Promise<{ ok: boolean; data?: any; error?: string; ms?: number }> {
  const t0 = Date.now();
  try {
    const r = await fetch(base + path, { signal: AbortSignal.timeout(TIMEOUT) });
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}`, ms };
    return { ok: true, data: await r.json(), ms };
  } catch (e: any) {
    return { ok: false, error: e?.message || "unreachable" };
  }
}

async function post(base: string, path: string, body: any): Promise<{ ok: boolean; data?: any; error?: string }> {
  try {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { msg = (await r.json()).error || msg; } catch { /* keep */ }
      return { ok: false, error: msg };
    }
    return { ok: true, data: await r.json() };
  } catch (e: any) {
    return { ok: false, error: e?.message || "unreachable" };
  }
}

// ---------------------------------------------------------------- status

export interface IntegrationStatus {
  name: string;
  url: string;
  reachable: boolean;
  ms?: number;
}

export async function integrationStatus(): Promise<IntegrationStatus[]> {
  const b = bases();
  const defs: Array<[string, string, string]> = [
    ["Daily Briefing", b.briefing, "/api/health"],
    ["Ascent", b.ascent, "/api/status"],
    ["Relay", b.relay, "/api/status"],
    ["Switchboard", b.switchboard, "/api/health"],
    ["Longview", b.longview, "/api/agent"],
  ];
  return Promise.all(
    defs.map(async ([name, url, health]) => {
      const r = await get(url, health);
      return { name, url, reachable: r.ok, ms: r.ms };
    })
  );
}

// ---------------------------------------------------------------- briefing

function pickText(v: any): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  return "";
}

export async function composeBrief(): Promise<{ speech: string; ok: boolean }> {
  const b = bases();
  const city = process.env.BRIEFING_CITY || "Cincinnati";
  const [w, news, tasks, mood] = await Promise.all([
    get(b.briefing, `/api/weather?city=${encodeURIComponent(city)}`),
    get(b.briefing, `/api/news?region=caricom`),
    get(b.briefing, `/api/tasks`),
    get(b.briefing, `/api/mood`),
  ]);
  if (!w.ok && !news.ok && !tasks.ok) {
    return { ok: false, speech: "I can't reach the Daily Briefing. Is it running?" };
  }
  const parts: string[] = [];
  const cur = w.data?.current;
  if (w.ok && cur) {
    parts.push(`${Math.round(Number(cur.temp_c) || 0)} degrees and ${pickText(cur.description) || "unknown skies"} in ${w.data?.place || city}.`);
  }
  const tlist: any[] = Array.isArray(tasks.data?.tasks) ? tasks.data.tasks
    : Array.isArray(tasks.data) ? tasks.data : [];
  const due = tlist.filter((t) => t && !/done|complete/i.test(String(t.status || t.state || "")));
  if (tasks.ok) {
    parts.push(due.length ? `You have ${due.length} open ${due.length === 1 ? "task" : "tasks"}.` : "No open tasks.");
  }
  const items: any[] = news.data?.items || news.data?.headlines || [];
  const heads = items.slice(0, 3).map((i) => pickText(i.title)).filter(Boolean);
  if (heads.length) parts.push("Headlines: " + heads.join(". ") + ".");
  const hn = mood.data?.hn ?? mood.data?.hackernews;
  const gr = mood.data?.guardian;
  if (mood.ok && (hn != null || gr != null)) {
    const bits: string[] = [];
    if (hn != null) bits.push(`tech mood ${Number(hn) >= 0 ? "up" : "down"} ${Math.abs(Math.round(Number(hn)))}`);
    if (gr != null) bits.push(`world mood ${Number(gr) >= 0 ? "up" : "down"} ${Math.abs(Math.round(Number(gr)))}`);
    if (bits.length) parts.push("Mood: " + bits.join(", ") + ".");
  }
  return { ok: true, speech: parts.join(" ") || "Briefing is empty today." };
}

// ---------------------------------------------------------------- ascent

export interface AscentTask { title: string; project_name?: string; due_date?: string }

export async function myDay(): Promise<{ speech: string; ok: boolean }> {
  const b = bases();
  const r = await get(b.ascent, "/api/myday");
  if (!r.ok) return { ok: false, speech: "I can't reach Ascent. Is it running?" };
  const d = r.data || {};
  const groups: Array<[string, any[]]> = [
    ["overdue", d.overdue || []],
    ["today", d.today || []],
    ["in progress", d.in_progress || []],
  ];
  const total = groups.reduce((n, [, g]) => n + g.length, 0);
  if (!total) return { ok: true, speech: "Nothing on your plate. The day is yours." };
  const bits: string[] = [];
  for (const [label, g] of groups) {
    if (!g.length) continue;
    const names = g.slice(0, 4).map((t: any) => String(t.title || t.name || "untitled"));
    bits.push(`${label}: ${names.join(", ")}${g.length > 4 ? `, and ${g.length - 4} more` : ""}`);
  }
  return { ok: true, speech: `You have ${total} ${total === 1 ? "task" : "tasks"}. ` + bits.join(". ") + "." };
}

export async function addTask(title: string, projectName?: string): Promise<{ speech: string; ok: boolean }> {
  const b = bases();
  const pr = await get(b.ascent, "/api/projects");
  if (!pr.ok) return { ok: false, speech: "I can't reach Ascent. Is it running?" };
  const projects: any[] = pr.data?.projects || pr.data || [];
  if (!projects.length) return { ok: false, speech: "Ascent has no projects yet." };
  let chosen = projects[0];
  if (projectName) {
    const q = projectName.toLowerCase();
    const hit = projects.find((p: any) => String(p.name || "").toLowerCase().includes(q));
    if (!hit) {
      const names = projects.slice(0, 5).map((p: any) => String(p.name || "untitled")).join(", ");
      return { ok: false, speech: `I don't know the project ${projectName}. Your projects are: ${names}.` };
    }
    chosen = hit;
  } else if (projects.length > 1) {
    // Ambiguous without a project name: name the default so the user can correct it.
    const names = projects.slice(0, 5).map((p: any) => String(p.name || "untitled")).join(", ");
    return {
      ok: false,
      speech: `Which project? I'll use ${chosen.name || "the first one"} unless you say otherwise. Your projects are: ${names}.`,
    };
  }
  const r = await post(b.ascent, "/api/quick-add", { project_id: chosen.id, text: title });
  if (!r.ok) return { ok: false, speech: `Couldn't add that: ${r.error}` };
  return { ok: true, speech: `Added "${title}" to ${chosen.name || "your project"}.` };
}

// ---------------------------------------------------------------- relay

export interface RelayConversation {
  id: string;
  title: string;
  last_channel: string;
  unread: number;
  last_body: string;
  last_at: string;
  last_direction: string;
}

export async function findConversation(name: string): Promise<{ ok: boolean; conv?: RelayConversation; error?: string }> {
  const b = bases();
  const r = await get(b.relay, "/api/conversations");
  if (!r.ok) return { ok: false, error: "I can't reach Relay. Is it running?" };
  const convs: RelayConversation[] = r.data?.conversations || [];
  const q = name.toLowerCase();
  const hit = convs.find((c) => !c.is_group && String(c.title || "").toLowerCase() === q)
    || convs.find((c) => String(c.title || "").toLowerCase().includes(q));
  if (!hit) return { ok: false, error: `I don't have a conversation with ${name}.` };
  return { ok: true, conv: hit };
}

export async function sendMessage(convId: string, channel: string, body: string): Promise<{ ok: boolean; error?: string }> {
  const b = bases();
  const r = await post(b.relay, `/api/conversations/${encodeURIComponent(convId)}/messages`, {
    channel: channel || "sms",
    body,
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function unreadMessages(): Promise<{ speech: string; ok: boolean }> {
  const b = bases();
  const r = await get(b.relay, "/api/conversations");
  if (!r.ok) return { ok: false, speech: "I can't reach Relay. Is it running?" };
  const convs: RelayConversation[] = r.data?.conversations || [];
  const unread = convs.filter((c) => (c.unread || 0) > 0).slice(0, 3);
  if (!unread.length) return { ok: true, speech: "No new messages." };
  const bits = unread.map((c) => {
    const body = String(c.last_body || "").slice(0, 120);
    return `${c.unread} from ${c.title}${body ? `: ${body}` : ""}`;
  });
  return { ok: true, speech: bits.join(". ") + "." };
}

// ---------------------------------------------------------------- switchboard

export interface SwNotification {
  id: number;
  title: string;
  body: string;
  channel_id: string;
  channel?: string; // legacy alias some builds return
  priority?: string;
  status: string;
  created_at: number;
}

export interface SwChannel {
  id: string;
  label?: string;
  mode: string; // instant | digest | muted
  enabled: number;
  min_priority: string;
  snoozed_until: number;
}

function notifChannel(n: SwNotification): string {
  return n.channel_id || n.channel || "";
}

export async function getChannels(): Promise<{ ok: boolean; channels: SwChannel[]; error?: string }> {
  const b = bases();
  const r = await get(b.switchboard, "/api/channels");
  if (!r.ok) return { ok: false, channels: [], error: "I can't reach Switchboard. Is it running?" };
  const list: any[] = r.data?.channels || [];
  return {
    ok: true,
    channels: list.map((c) => ({
      id: String(c.id || ""),
      label: c.meta?.label || c.label,
      mode: String(c.mode || "instant"),
      enabled: Number(c.enabled ?? 1),
      min_priority: String(c.min_priority || "low"),
      snoozed_until: Number(c.snoozed_until || 0),
    })),
  };
}

export async function findChannel(name: string): Promise<{ ok: boolean; channel?: SwChannel; error?: string }> {
  const r = await getChannels();
  if (!r.ok) return { ok: false, error: r.error };
  const q = name.toLowerCase().trim();
  const hit = r.channels.find((c) => c.id.toLowerCase() === q)
    || r.channels.find((c) => (c.label || "").toLowerCase() === q)
    || r.channels.find((c) => c.id.toLowerCase().includes(q) || (c.label || "").toLowerCase().includes(q));
  if (!hit) return { ok: false, error: `I don't know a ${name} channel.` };
  return { ok: true, channel: hit };
}

/** Mute a channel for `minutes` (1..1440). */
export async function muteChannel(id: string, minutes: number): Promise<{ ok: boolean; error?: string }> {
  const b = bases();
  const r = await post(b.switchboard, `/api/channels/${encodeURIComponent(id)}/snooze`, {
    minutes: Math.max(1, Math.min(1440, Math.round(minutes))),
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function unmuteChannel(id: string): Promise<{ ok: boolean; error?: string }> {
  const b = bases();
  const r = await post(b.switchboard, `/api/channels/${encodeURIComponent(id)}/snooze`, { clear: true });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export interface QuietState {
  reachable: boolean;
  enabled: boolean;
  inQuiet: boolean;
  urgentBreaks: boolean;
}

/** Read Switchboard's quiet-hours settings and evaluate them for right now
 *  (server-local time; both apps run on the same machine). */
export async function getQuietState(now = Date.now()): Promise<QuietState> {
  const b = bases();
  const r = await get(b.switchboard, "/api/settings");
  if (!r.ok) return { reachable: false, enabled: false, inQuiet: false, urgentBreaks: true };
  const s: Record<string, string> = r.data?.settings || {};
  const enabled = s.quiet_enabled === "1";
  const urgentBreaks = s.urgent_breaks_quiet !== "0";
  let inQuiet = false;
  if (enabled) {
    const d = new Date(now);
    const mins = d.getHours() * 60 + d.getMinutes();
    const parse = (v: string) => {
      const m = /^(\d{2}):(\d{2})$/.exec(v || "");
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const start = parse(s.quiet_start || ""), end = parse(s.quiet_end || "");
    if (start != null && end != null) {
      inQuiet = start <= end ? (mins >= start && mins < end) : (mins >= start || mins < end);
    }
  }
  return { reachable: true, enabled, inQuiet, urgentBreaks };
}

/** Urgent notifications newer than `since` (created_at ms), live only.
 *  Mirrors Switchboard's own semantics: priority "urgent" bypasses channel mode. */
export async function urgentSince(since: number): Promise<SwNotification[]> {
  const b = bases();
  const r = await get(b.switchboard, "/api/notifications?limit=20");
  if (!r.ok) return [];
  const all: SwNotification[] = r.data?.notifications || [];
  return all
    .filter((n) => (n.priority || "normal") === "urgent")
    .filter((n) => n.status !== "dismissed" && n.status !== "snoozed")
    .filter((n) => Number(n.created_at || 0) > since)
    .sort((a, b) => Number(a.created_at) - Number(b.created_at));
}

export interface DigestItem {
  id: number;
  title: string;
  body: string;
  channel: string;
  channelLabel: string;
}

export interface DigestResult {
  ok: boolean;
  items: DigestItem[];
  quietHours: boolean; // true when quiet hours filtered the list to urgent-only
  error?: string;
}

/** Items for the spoken triage digest. Respects channel routing (muted /
 *  disabled / snoozed channels are excluded) and quiet hours (urgent-only
 *  when urgent breaks through; empty otherwise). */
export async function digestItems(): Promise<DigestResult> {
  const b = bases();
  const [chR, qR, nR] = await Promise.all([
    getChannels(),
    getQuietState(),
    get(b.switchboard, "/api/notifications?limit=10"),
  ]);
  if (!nR.ok) return { ok: false, items: [], quietHours: false, error: "I can't reach Switchboard. Is it running?" };
  const now = Date.now();
  const labels = new Map<string, string>();
  const hidden = new Set<string>();
  if (chR.ok) {
    for (const c of chR.channels) {
      if (c.label) labels.set(c.id, c.label);
      if (c.mode === "muted" || !c.enabled || c.snoozed_until > now) hidden.add(c.id);
    }
  }
  const quietOnlyUrgent = qR.reachable && qR.inQuiet && qR.urgentBreaks;
  const quietSilent = qR.reachable && qR.inQuiet && !qR.urgentBreaks;
  const all: SwNotification[] = nR.data?.notifications || [];
  const items = all
    .filter((n) => n.status !== "dismissed" && n.status !== "snoozed")
    .filter((n) => !hidden.has(notifChannel(n)))
    .filter((n) => !quietSilent)
    .filter((n) => !quietOnlyUrgent || (n.priority || "normal") === "urgent")
    .slice(0, 5)
    .map((n) => {
      const cid = notifChannel(n);
      return {
        id: n.id,
        title: String(n.title || "notification"),
        body: String(n.body || "").slice(0, 100),
        channel: cid,
        channelLabel: labels.get(cid) || cid,
      };
    });
  return { ok: true, items, quietHours: quietOnlyUrgent || quietSilent };
}

export async function snoozeNotification(id: number, minutes: number): Promise<{ ok: boolean; error?: string }> {
  const b = bases();
  const r = await post(b.switchboard, `/api/notifications/${id}/snooze`, { minutes });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

export async function dismissNotification(id: number): Promise<{ ok: boolean; error?: string }> {
  const b = bases();
  const r = await post(b.switchboard, `/api/notifications/${id}/dismiss`, {});
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// ---------------------------------------------------------------- longview

export interface LvRun {
  id: number;
  question: string;
  status: string; // pending | working | done | error
  created_at: number;
  findings: number;
  sources: number;
}

const LV_UNREACHABLE = "I can't reach Longview. Is it running?";

export async function listRuns(): Promise<{ ok: boolean; runs: LvRun[]; error?: string }> {
  const r = await get(bases().longview, "/api/agent");
  if (!r.ok || !r.data?.ok) return { ok: false, runs: [], error: LV_UNREACHABLE };
  const runs: LvRun[] = (r.data.runs || []).map((x: any) => ({
    id: Number(x.id),
    question: String(x.question || ""),
    status: String(x.status || ""),
    created_at: Number(x.created_at || 0),
    findings: Number(x.findings || 0),
    sources: Number(x.sources || 0),
  }));
  return { ok: true, runs };
}

export async function startResearch(question: string): Promise<{ ok: boolean; runId?: number; error?: string }> {
  const r = await post(bases().longview, "/api/agent", { question });
  if (!r.ok) return { ok: false, error: LV_UNREACHABLE };
  if (!r.data?.ok) return { ok: false, error: r.data?.error || "Longview refused the research request." };
  return { ok: true, runId: Number(r.data.run_id) };
}

export async function getRun(id: number): Promise<{ ok: boolean; run?: any; error?: string }> {
  const r = await get(bases().longview, `/api/agent/${id}`);
  if (!r.ok || !r.data?.ok) return { ok: false, error: "Couldn't load that research run." };
  return { ok: true, run: r.data.run };
}

/** Extract up to maxPoints spoken key points from a Longview report.
 *  Pure function — the report's "## Key points" bullets, markdown stripped. */
export function spokenSummary(reportMd: string, maxPoints = 3): string[] {
  const lines = String(reportMd || "").split("\n");
  const start = lines.findIndex((l) => /^##\s+key points/i.test(l.trim()));
  const points: string[] = [];
  if (start >= 0) {
    for (const l of lines.slice(start + 1)) {
      if (/^##\s/.test(l.trim())) break;
      const m = l.match(/^\s*-\s+(.+)$/);
      if (m) {
        points.push(
          m[1].trim()
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
            .replace(/[*_~`]/g, "")
        );
      }
      if (points.length >= maxPoints) break;
    }
  }
  return points.filter(Boolean);
}

export async function summarizeRun(id: number): Promise<{ speech: string; ok: boolean }> {
  const g = await getRun(id);
  if (!g.ok || !g.run) return { ok: false, speech: g.error || "Couldn't load that research." };
  const run = g.run;
  const q = String(run.question || "that topic");
  if (run.status !== "done") {
    const state = run.status === "working" || run.status === "pending" ? "still running" : `in state ${run.status}`;
    return { ok: true, speech: `Research on "${q}" is ${state}.` };
  }
  const points = spokenSummary(String(run.report_md || ""));
  if (!points.length) return { ok: true, speech: `Research on "${q}" is done, but produced no key points.` };
  return { ok: true, speech: `On "${q}": ${points.map((p, i) => `${i + 1}. ${p}`).join(" ")}` };
}

export async function researchStatus(): Promise<{ speech: string; ok: boolean }> {
  const l = await listRuns();
  if (!l.ok) return { ok: false, speech: l.error || LV_UNREACHABLE };
  const working = l.runs.filter((r) => r.status === "working" || r.status === "pending");
  const done = l.runs.filter((r) => r.status === "done").slice(0, 3);
  const bits: string[] = [];
  if (working.length) {
    bits.push(`Running: ${working.slice(0, 3).map((r) => `"${r.question}"`).join(", ")}.`);
  }
  if (done.length) {
    bits.push(`Recent: ${done.map((r) => `"${r.question}" (${r.findings} findings)`).join(", ")}.`);
  }
  return { ok: true, speech: bits.join(" ") || "No research runs yet." };
}

/** Latest done run, optionally matching a topic substring (case-insensitive). */
export function findRun(runs: LvRun[], topic?: string): LvRun | null {
  const done = runs.filter((r) => r.status === "done");
  if (!topic) return done[0] || null;
  const q = topic.toLowerCase();
  return done.find((r) => r.question.toLowerCase().includes(q)) || null;
}
