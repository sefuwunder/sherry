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
  channel: string;
  priority?: string;
  status: string;
  created_at: number;
}

export async function digest(): Promise<{ speech: string; ok: boolean; mentioned: Array<{ id: number; title: string }> }> {
  const b = bases();
  const r = await get(b.switchboard, "/api/notifications?limit=10");
  if (!r.ok) return { ok: false, speech: "I can't reach Switchboard. Is it running?", mentioned: [] };
  const all: SwNotification[] = r.data?.notifications || [];
  const live = all.filter((n) => n.status !== "dismissed" && n.status !== "snoozed").slice(0, 5);
  if (!live.length) return { ok: true, speech: "Nothing new. All quiet.", mentioned: [] };
  const mentioned = live.map((n) => ({ id: n.id, title: String(n.title || "notification") }));
  const bits = live.map((n, i) => {
    const chan = n.channel ? `${n.channel}: ` : "";
    const body = String(n.body || "").slice(0, 100);
    return `${i + 1}: ${chan}${n.title}${body ? ` — ${body}` : ""}`;
  });
  const head = live.length === 1 ? "One notification." : `${live.length} notifications.`;
  return {
    ok: true,
    speech: head + " " + bits.join(". ") + ". Say snooze that, or dismiss that.",
    mentioned,
  };
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
