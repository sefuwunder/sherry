// sherry: HTTP app. Voice pipeline:
//   POST /api/hear (wav) -> whisper -> route() -> action -> { transcript, speech }
// Multi-turn state (pending confirmations, last-mentioned notifications) is
// in-memory; single user, single machine.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, rmSync } from "node:fs";
import { dataDir, getDb, logHear, recentHear } from "./db";
import { transcribeBuffer, isValidWav, getSttStatus } from "./stt";
import { route, HELP_SPEECH, type Route } from "./router";
import {
  integrationStatus, composeBrief, myDay, addTask,
  findConversation, sendMessage, unreadMessages,
  digest, snoozeNotification, dismissNotification,
} from "./clients";

const PUBLIC_DIR = new URL("../public/", import.meta.url).pathname;
const MAX_WAV = 10 * 1024 * 1024; // ~5.5 min at 16kHz/16-bit mono

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
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
let lastMentioned: Array<{ id: number; title: string }> = [];

/** Test hook: clear multi-turn conversation state. */
export function __resetConversationForTests(): void {
  pendingSend = null;
  lastMentioned = [];
}

function takePending(): PendingSend | null {
  const p = pendingSend;
  pendingSend = null;
  if (!p || p.expires < Date.now()) return null;
  return p;
}

// ---------------------------------------------------------------- actions

interface ActionResult {
  speech: string;
  pending?: { kind: string; prompt: string };
}

async function act(r: Route): Promise<ActionResult> {
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
      const d = await digest();
      lastMentioned = d.mentioned;
      return { speech: d.speech };
    }
    case "snooze": {
      const first = lastMentioned[0];
      if (!first) return { speech: "Snooze what? Ask me what's new first." };
      const minutes = Number(r.slots.minutes || 30);
      const ok = await snoozeNotification(first.id, minutes);
      if (ok.ok) {
        lastMentioned = lastMentioned.filter((m) => m.id !== first.id);
        return { speech: `Snoozed "${first.title}" for ${minutes >= 60 ? `${minutes / 60} hour${minutes >= 120 ? "s" : ""}` : `${minutes} minutes`}.` };
      }
      return { speech: `Couldn't snooze: ${ok.error}` };
    }
    case "dismiss": {
      const first = lastMentioned[0];
      if (!first) return { speech: "Dismiss what? Ask me what's new first." };
      const ok = await dismissNotification(first.id);
      if (ok.ok) {
        lastMentioned = lastMentioned.filter((m) => m.id !== first.id);
        return { speech: `Dismissed "${first.title}".` };
      }
      return { speech: `Couldn't dismiss: ${ok.error}` };
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
