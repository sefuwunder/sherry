// sherry: deterministic intent router. No LLM, no network — pure function
// from transcript text to { intent, slots }. Spoken confirmations and the
// multi-turn pending slot live in app.ts; this module only classifies.
export type IntentName =
  | "brief"
  | "myday"
  | "add_task"
  | "message"
  | "confirm"
  | "cancel"
  | "new_messages"
  | "digest"
  | "snooze"
  | "dismiss"
  | "help"
  | "unknown";

export interface Route {
  intent: IntentName;
  slots: Record<string, string>;
}

function norm(t: string): string {
  // Keep apostrophes and hyphens: "i'll" must survive for TTS ("ill" reads as "sick"),
  // and names like "mary-jane" or "d'angelo" stay intact.
  return t.toLowerCase().replace(/[.,!?;:"""]/g, "").replace(/\s+/g, " ").trim();
}

/** Strip a leading wake-ish opener like "hey sherry" / "sherry". */
function stripOpener(t: string): string {
  return t.replace(/^(hey |ok )?sherry[, ]+/, "").trim();
}

export function route(raw: string): Route {
  const t = stripOpener(norm(raw));

  // --- confirm / cancel first: single-word utterances must win ---
  if (/^(yes|yeah|yep|yup|sure|send it|do it|confirm|go ahead)$/.test(t)) {
    return { intent: "confirm", slots: {} };
  }
  if (/^(no|nope|cancel|never mind|nevermind|forget it|stop)$/.test(t)) {
    return { intent: "cancel", slots: {} };
  }

  // --- briefing ---
  if (/\b(briefing|brief me|morning brief|how'?s my day|what'?s the news|news|headlines)\b/.test(t)) {
    return { intent: "brief", slots: {} };
  }

  // --- ascent: my day ---
  if (/\b(what'?s on my plate|my tasks|tasks today|what do i have( today| on)?|today'?s tasks|my day)\b/.test(t)) {
    return { intent: "myday", slots: {} };
  }

  // --- ascent: add task ---
  // "add task buy milk to Groceries" / "add buy milk" / "create call dany for work"
  // NOTE: the "add task" form is checked first so "task" isn't eaten as the title.
  let m = t.match(/^(?:add|create)(?: a)? task (.+)$/) || t.match(/^(?:add|create) (.+)$/);
  if (m) {
    const rest = m[1].trim();
    const pm = rest.match(/^(.+?) (?:to|in|for) (.+)$/);
    if (pm) return { intent: "add_task", slots: { title: pm[1].trim(), project: pm[2].trim() } };
    return { intent: "add_task", slots: { title: rest } };
  }

  // --- relay: send a message ---
  // "message shy i'll be late" / "text danyetta happy birthday" / "tell shy call me"
  // "me"/"myself" is never a contact ("tell me a joke" -> unknown).
  m = t.match(/^(?:message|text|tell) ([a-z][a-z'’-]*) (.+)$/);
  if (m && !/^(me|myself|us)$/.test(m[1])) {
    return { intent: "message", slots: { contact: m[1].trim(), body: m[2].trim() } };
  }

  // --- relay: read new messages ---
  if (/\b(any new messages|new messages|read (my )?messages|check (my )?messages|unread|any texts)\b/.test(t)) {
    return { intent: "new_messages", slots: {} };
  }

  // --- switchboard: digest ---
  if (/\b(what'?s new|anything urgent|notifications?|alerts?)\b/.test(t)) {
    return { intent: "digest", slots: {} };
  }

  // --- switchboard: snooze / dismiss ("that" = last mentioned notification) ---
  m = t.match(/\bsnooze(?: that| it| this)?(?: for (\d+) ?(minute|hour)s?)?/);
  if (m) {
    const n = m[1] ? Number(m[1]) : 30;
    const minutes = m[2] === "hour" ? n * 60 : n;
    return { intent: "snooze", slots: { minutes: String(Math.max(1, Math.min(1440, minutes))) } };
  }
  if (/\bdismiss( that| it| this)?\b/.test(t)) {
    return { intent: "dismiss", slots: {} };
  }

  // --- help ---
  if (/\b(help|what can you do|commands)\b/.test(t)) {
    return { intent: "help", slots: {} };
  }

  return { intent: "unknown", slots: {} };
}

/** Spoken help text, kept short for TTS. */
export const HELP_SPEECH =
  "You can say: brief me. What's on my plate. Add task buy milk. " +
  "Message Shy I'll be late. Any new messages. What's new. Snooze that. Or dismiss that.";
