// sherry: HTTP app. Voice pipeline:
//   POST /api/hear (wav) -> whisper -> route() -> action -> { transcript, speech }
// Urgent Switchboard items chime via SSE (/api/events): two soft tones in the
// browser, no spoken content until the user asks ("what was that").
// Multi-turn state (pending confirmations, triage, last chime) is in-memory;
// single user, single machine.
import { join } from "node:path";
import { dataDir, logHear, recentHear } from "./db";
import { transcribeBuffer, isValidWav, getSttStatus } from "./stt";
import { route, HELP_SPEECH, type Route } from "./router";
import {
  integrationStatus, composeBrief, myDay, addTask,
  findConversation, sendMessage, unreadMessages,
  digestItems, snoozeNotification, dismissNotification,
  findChannel, muteChannel, unmuteChannel,
  getQuietState, urgentSince, getChannels,
  type DigestItem,
} from "./clients";

const PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;
const MAX_WAV = 10 * 1024 * 1024; // ~5.5 min at 16kHz/16-bit mono

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------- SSE

type SseSend = (line: string) => void;
const sseClients = new Set<SseSend>();

function broadcast(msg: unknown): void {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const send of sseClients) {
    try {
      send(line);
    } catch {
      /* drop dead client */
    }
  }
}

// ---------------------------------------------------------------- multi-turn

interface PendingSend {
  contactName: string;
  convId: string;
  channel: string;
  body: string;
  expires: number;
}
let pendingSend: PendingSend | null = null;
let triage: { items: DigestItem[]; index: number } | null = null;
let lastChimed: Array<{ id: number; title: string; channelLabel: string }> = [];
let lastUrgentSeenAt = 0;

/** Test hook: clear multi-turn conversation state. */
export function __resetConversationForTests(): void {
  pendingSend = null;
  triage = null;
  lastChimed = [];
  lastUrgentSeenAt = 0;
}

/** Test hook: seed the last-chimed list. */
export function __setLastChimedForTests(items: Array<{ id: number; title: string; channelLabel: string }>): void {
  lastChimed = items;
}

function takePending(): PendingSend | null {
  const p = pendingSend;
  pendingSend = null;
  if (!p || p.expires < Date.now()) return null;
  return p;
}

// ---------------------------------------------------------------- urgent watcher

let watcherTimer: ReturnType<typeof setInterval> | null = null;

/** Poll Switchboard for new urgent notifications; chime (via SSE) once per
 *  batch. Not started in tests — server.ts starts it. */
export function startUrgentWatcher(intervalMs = 30_000): void {
  if (watcherTimer) return;
  void syncUrgent(true); // initial sync: mark current urgents seen, no chime
  watcherTimer = setInterval(() => void syncUrgent(false), intervalMs);
  setInterval(() => broadcast({ type: "ping", time: Date.now() }), 25_000);
}

/** Test hook: run one watcher pass. Returns true if it chimed. */
export async function __syncUrgentForTests(silent: boolean): Promise<boolean> {
  return syncUrgent(silent);
}

async function syncUrgent(silent: boolean): Promise<boolean> {
  let fresh;
  try {
    fresh = await urgentSince(lastUrgentSeenAt);
  } catch {
    return false; // Switchboard unreachable — try next tick
  }
  if (!fresh.length) return false;
  lastUrgentSeenAt = Math.max(lastUrgentSeenAt, ...fresh.map((n) => Number(n.created_at || 0)));
  if (silent) return false;
  // Quiet hours: only chime when urgent breaks through (Switchboard's own rule).
  const q = await getQuietState();
  if (q.reachable && q.inQuiet && !q.urgentBreaks) return false;
  let labels = new Map<string, string>();
  try {
    const ch = await getChannels();
    if (ch.ok) for (const c of ch.channels) labels.set(c.id, c.label || c.id);
  } catch { /* labels optional */ }
  lastChimed = fresh.slice(-3).map((n) => ({
    id: n.id,
    title: String(n.title || "notification"),
    channelLabel: labels.get(n.channel_id || "") || "",
  }));
  broadcast({ type: "urgent", count: fresh.length, time: Date.now() });
  return true;
}

// ---------------------------------------------------------------- helpers

function parseMuteDuration(s: string, now = Date.now()): number {
  s = (s || "").trim().toLowerCase();
  if (!s) return 60;
  if (s === "today") {
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return Math.max(1, Math.min(1440, Math.round((end.getTime() - now) / 60000)));
  }
  const m = s.match(/^(\d+)\s*(minute|hour)s?$/);
  if (m) {
    const n = Number(m[1]);
    return Math.max(1, Math.min(1440, m[2] === "hour" ? n * 60 : n));
  }
  return 60;
}

function humanMinutes(min: number): string {
  if (min >= 60 && min % 60 === 0) {
    const h = min / 60;
    return h === 1 ? "an hour" : `${h} hours`;
  }
  return min === 1 ? "a minute" : `${min} minutes`;
}

function triageSpeech(first: boolean): string {
  const t = triage!;
  const item = t.items[t.index];
  const pos = `${t.index + 1} of ${t.items.length}`;
  const chan = item.channelLabel ? `${item.channelLabel} — ` : "";
  const body = item.body ? `. ${item.body}` : "";
  const nav = first ? " Say next, snooze, or dismiss." : "";
  return `${pos}: ${chan}${item.title}${body}.${nav}`;
}

/** Advance triage past the current item; null when the queue is exhausted. */
function triageAdvance(): string | null {
  const t = triage!;
  t.index += 1;
  if (t.index >= t.items.length) {
    triage = null;
    return null;
  }
  return triageSpeech(false);
}

// ---------------------------------------------------------------- actions

interface ActionResult {
  speech: string;
  pending?: { kind: string; prompt: string };
}

async function act(r: Route): Promise<ActionResult> {
  // Triage is sticky only for triage verbs; anything else closes it.
  if (triage && !["triage_next", "snooze", "dismiss", "cancel"].includes(r.intent)) {
    triage = null;
  }

  switch (r.intent) {
    case "brief": {
      const { speech } = await composeBrief();
      return { speech };
    }
    case "myday": {
      const { speech } = await myDay();
      return { speech };
    }
    case "add_task": {
      const title = (r.slots.title || "").trim();
      if (!title) return { speech: "What should the task say?" };
      const { speech } = await addTask(title, r.slots.project);
      return { speech };
    }
    case "message": {
      const found = await findConversation(r.slots.contact || "");
      if (!found.ok || !found.conv) return { speech: found.error || "Couldn't find that conversation." };
      const body = (r.slots.body || "").trim();
      if (!body) return { speech: `What should I say to ${found.conv.title}?` };
      const channel = found.conv.last_channel || "sms";
      pendingSend = {
        contactName: found.conv.title, convId: found.conv.id,
        channel, body, expires: Date.now() + 2 * 60 * 1000,
      };
      return {
        speech: `Ready to ${channel} ${found.conv.title}: "${body}". Say yes to send, or no to cancel.`,
        pending: { kind: "relay-send", prompt: `Send to ${found.conv.title}` },
      };
    }
    case "confirm": {
      const p = takePending();
      if (!p) return { speech: "Nothing waiting for confirmation." };
      const sent = await sendMessage(p.convId, p.channel, p.body);
      return { speech: sent.ok ? `Sent to ${p.contactName}.` : `Couldn't send: ${sent.error}` };
    }
    case "cancel": {
      if (triage) {
        triage = null;
        return { speech: "Done with notifications." };
      }
      if (pendingSend) {
        pendingSend = null;
        return { speech: "Cancelled." };
      }
      return { speech: "Nothing to cancel." };
    }
    case "new_messages": {
      const { speech } = await unreadMessages();
      return { speech };
    }
    case "digest": {
      const d = await digestItems();
      if (!d.ok) return { speech: d.error || "Couldn't load notifications." };
      if (!d.items.length) {
        return { speech: d.quietHours ? "It's quiet hours. Nothing urgent." : "Nothing new. All quiet." };
      }
      triage = { items: d.items, index: 0 };
      const head = d.items.length === 1 ? "One notification." : `${d.items.length} notifications.`;
      const quiet = d.quietHours ? "It's quiet hours — urgent only. " : "";
      return { speech: quiet + head + " " + triageSpeech(true) };
    }
    case "triage_next": {
      if (!triage) return { speech: "No digest open. Say what's new first." };
      const next = triageAdvance();
      return { speech: next || "That's all of them." };
    }
    case "snooze": {
      const target = triage ? triage.items[triage.index] : null;
      if (!target) return { speech: "Snooze what? Say what's new first." };
      const minutes = Number(r.slots.minutes || 30);
      const ok = await snoozeNotification(target.id, minutes);
      if (!ok.ok) return { speech: `Couldn't snooze: ${ok.error}` };
      const label = target.channelLabel ? `${target.channelLabel} — ` : "";
      const next = triageAdvance();
      const done = `Snoozed ${label}"${target.title}" for ${humanMinutes(minutes)}.`;
      return { speech: next ? `${done} ${next}` : `${done} That's all of them.` };
    }
    case "dismiss": {
      const target = triage ? triage.items[triage.index] : null;
      if (!target) return { speech: "Dismiss what? Say what's new first." };
      const ok = await dismissNotification(target.id);
      if (!ok.ok) return { speech: `Couldn't dismiss: ${ok.error}` };
      const label = target.channelLabel ? `${target.channelLabel} — ` : "";
      const next = triageAdvance();
      const done = `Dismissed ${label}"${target.title}".`;
      return { speech: next ? `${done} ${next}` : `${done} That's all of them.` };
    }
    case "mute_channel": {
      const found = await findChannel(r.slots.channel || "");
      if (!found.ok || !found.channel) return { speech: found.error || "Couldn't find that channel." };
      const minutes = parseMuteDuration(r.slots.duration || "");
      const ok = await muteChannel(found.channel.id, minutes);
      if (!ok.ok) return { speech: `Couldn't mute: ${ok.error}` };
      const name = found.channel.label || found.channel.id;
      return { speech: `Muted ${name} for ${humanMinutes(minutes)}.` };
    }
    case "unmute_channel": {
      const found = await findChannel(r.slots.channel || "");
      if (!found.ok || !found.channel) return { speech: found.error || "Couldn't find that channel." };
      const ok = await unmuteChannel(found.channel.id);
      if (!ok.ok) return { speech: `Couldn't unmute: ${ok.error}` };
      const name = found.channel.label || found.channel.id;
      return { speech: `Unmuted ${name}.` };
    }
    case "what_was_that": {
      if (!lastChimed.length) return { speech: "Nothing chimed recently." };
      const bits = lastChimed.map((c) => `${c.channelLabel ? c.channelLabel + " — " : ""}${c.title}`);
      return { speech: `That was: ${bits.join(". ")}.` };
    }
    case "help":
      return { speech: HELP_SPEECH };
    default:
      return { speech: "I didn't catch that. Say help to hear what I can do." };
  }
}

// ---------------------------------------------------------------- routes

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;

  if (p === "/api/health") return json({ ok: true, time: new Date().toISOString() });

  if (p === "/api/events" && m === "GET") {
    let send!: SseSend;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        send = (line: string) => {
          try {
            controller.enqueue(enc.encode(line));
          } catch {
            sseClients.delete(send);
          }
        };
        sseClients.add(send);
        send(`data: ${JSON.stringify({ type: "hello", time: Date.now() })}\n\n`);
      },
      cancel() {
        sseClients.delete(send);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  if (p === "/api/stt/status" && m === "GET") {
    return json(getSttStatus(dataDir()));
  }

  if (p === "/api/integrations" && m === "GET") {
    return json({ integrations: await integrationStatus() });
  }

  if (p === "/api/log" && m === "GET") {
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 20));
    return json({ entries: recentHear(limit) });
  }

  // --- the voice pipeline ---
  if (p === "/api/hear" && m === "POST") {
    let wav: Uint8Array | null = null;
    try {
      const form = await req.formData();
      const file = form.get("audio");
      if (file instanceof File) {
        if (file.size > MAX_WAV) return json({ error: "audio too long" }, 413);
        wav = new Uint8Array(await file.arrayBuffer());
      }
    } catch {
      return json({ error: "couldn't read audio" }, 400);
    }
    if (!wav || !wav.length) return json({ error: "no audio" }, 400);
    if (!isValidWav(wav)) return json({ error: "audio must be WAV" }, 400);

    let transcript: string;
    try {
      transcript = await transcribeBuffer(dataDir(), wav);
    } catch (e: any) {
      const msg = String(e?.message || "transcription failed");
      const engineMissing = /not available/i.test(msg);
      return json({
        error: msg,
        engineMissing,
        speech: engineMissing
          ? "Voice transcription isn't set up yet. Run scripts/setup-stt.sh, then restart me."
          : "I couldn't make out any words. Try again.",
      }, engineMissing ? 503 : 500);
    }
    if (!transcript) {
      return json({ transcript: "", intent: "unknown", speech: "I didn't hear anything. Try again." });
    }

    const r = route(transcript);
    let result: ActionResult;
    try {
      result = await act(r);
    } catch (e: any) {
      result = { speech: "Something went wrong on my end. Try again." };
    }
    try { logHear(transcript, r.intent, result.speech); } catch { /* non-fatal */ }
    return json({
      transcript,
      intent: r.intent,
      speech: result.speech,
      pending: result.pending || null,
    });
  }

  // --- text fallback: same pipeline, no audio (for testing / no-mic) ---
  if (p === "/api/ask" && m === "POST") {
    let body: any = {};
    try { body = await req.json(); } catch { /* keep */ }
    const text = String(body.text || "").slice(0, 500).trim();
    if (!text) return json({ error: "no text" }, 400);
    const r = route(text);
    let result: ActionResult;
    try {
      result = await act(r);
    } catch {
      result = { speech: "Something went wrong on my end. Try again." };
    }
    try { logHear(text, r.intent, result.speech); } catch { /* non-fatal */ }
    return json({ transcript: text, intent: r.intent, speech: result.speech, pending: result.pending || null });
  }

  // --- static ---
  const rel = p === "/" ? "/index.html" : p;
  const file = Bun.file(join(PUBLIC_DIR, rel.replace(/^\//, "")));
  if (await file.exists()) {
    const ext = rel.split(".").pop() || "";
    const type = ext === "html" ? "text/html" : ext === "js" ? "text/javascript"
      : ext === "css" ? "text/css" : ext === "svg" ? "image/svg+xml" : "application/octet-stream";
    return new Response(file, { headers: { "content-type": type } });
  }
  if (p.startsWith("/api/")) return json({ error: "not found" }, 404);
  return new Response(Bun.file(join(PUBLIC_DIR, "index.html")), {
    headers: { "content-type": "text/html" },
  });
}
