// sherry: deterministic intent router. No LLM, no network — pure function
// from transcript text to { intent, slots }. Spoken confirmations and the
// multi-turn pending slot live in app.ts; this module only classifies.
// When no exact pattern matches, a fuzzy layer (./fuzzy) attempts
// typo/paraphrase recovery before falling back to "unknown".
import { fuzzyRoute } from "./fuzzy";
export type IntentName =
  | "brief"
  | "myday"
  | "add_task"
  | "message"
  | "confirm"
  | "cancel"
  | "new_messages"
  | "digest"
  | "triage_next"
  | "snooze"
  | "dismiss"
  | "mute_channel"
  | "unmute_channel"
  | "what_was_that"
  | "research_start"
  | "research_status"
  | "research_findings"
  | "suggest"
  | "learned"
  | "relationships"
  | "calendar_today"
  | "calendar_tomorrow"
  | "calendar_next"
  | "remind"
  | "timer"
  | "reminders_list"
  | "reminder_cancel"
  | "note"
  | "think"
  | "thoughts"
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

/**
 * Split a compound command on conjunctions: "brief me and mute github"
 * -> ["brief me", "mute github"]. Returns null when no conjunction is found.
 * Splitting is naive; the caller must verify every segment routes to a known
 * intent, otherwise the whole utterance is treated as a single command
 * (protects "message shy buy milk and eggs" from splitting mid-body).
 */
export function splitCompound(t: string): string[] | null {
  const parts = t
    .split(/\s+(?:and then|after that|followed by|then|and|plus)\s+|\s*,\s*|\s+&\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  if (parts.length > 4) return null; // sanity cap
  return parts;
}

export function route(raw: string): Route {
  const t = stripOpener(norm(raw));

  // --- confirm / cancel first: single-word utterances must win ---
  // "stop"/"done" double as triage exit (context resolved in app.ts).
  if (/^(yes|yeah|yep|yup|sure|send it|do it|confirm|go ahead)$/.test(t)) {
    return { intent: "confirm", slots: {} };
  }
  if (/^(no|nope|cancel|never mind|nevermind|forget it|stop|done|that's all|thats all)$/.test(t)) {
    return { intent: "cancel", slots: {} };
  }

  // --- briefing ---
  if (/\b(briefing|brief me|morning brief|how'?s my day|what'?s the news|news|headlines)\b/.test(t)) {
    return { intent: "brief", slots: {} };
  }

  // --- sherry: analyze + suggest ("what should i do", "prioritize my day") ---
  if (/\b(suggest(ions)?|what should i do|what needs (my )?attention|prioritize|what'?s important|analyze( my day)?|any suggestions)\b/.test(t)) {
    return { intent: "suggest", slots: {} };
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

  // --- switchboard: triage navigation ("next" while a digest is open) ---
  if (/^(next|skip)$/.test(t)) {
    return { intent: "triage_next", slots: {} };
  }

  // --- switchboard: what was the chime? (after an urgent tone pair) ---
  if (/\bwhat was that\b|\bwhat'?s (that|the chime)\b|\bthe chime\b|\bwhat was the tone\b/.test(t)) {
    return { intent: "what_was_that", slots: {} };
  }

  // --- switchboard: channel mute / unmute ---
  // "mute github" / "mute github for 2 hours" / "mute github for today" / "unmute github"
  m = t.match(/^unmute ([a-z0-9][a-z0-9 _-]*)$/);
  if (m) return { intent: "unmute_channel", slots: { channel: m[1].trim() } };
  m = t.match(/^mute ([a-z0-9][a-z0-9 _-]*?)(?: for (today|\d+ ?(?:minute|hour)s?))?$/);
  if (m) {
    return { intent: "mute_channel", slots: { channel: m[1].trim(), duration: (m[2] || "").trim() } };
  }

  // --- longview: research status (before research_start: "research status" has a topic) ---
  if (/^research (status|update)$/.test(t)
    || /\bhow'?s my research\b/.test(t)
    || /\bany research (running|going on)\b/.test(t)) {
    return { intent: "research_status", slots: {} };
  }

  // --- longview: findings ---
  // "what did you find on tariffs" / "summarize the tariff research" / "research findings"
  // (before research_start: bare "research findings" is a findings query, not a topic)
  m = t.match(/^what did you find (?:on |about )?(.+)$/);
  if (m) return { intent: "research_findings", slots: { topic: m[1].trim() } };
  m = t.match(/^summarize (?:the |my )?(.+?) research$/);
  if (m) return { intent: "research_findings", slots: { topic: m[1].trim() } };
  if (/^(what did you find|research findings|show findings)$/.test(t)) {
    return { intent: "research_findings", slots: {} };
  }

  // --- longview: start a research run ---
  // "research electric vehicle subsidies" / "look into zoning laws" / "investigate supply chain delays"
  m = t.match(/^(?:research|look into|investigate) (.+)$/);
  if (m) {
    return { intent: "research_start", slots: { topic: m[1].trim() } };
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

  // --- sherry: what has the engine learned? ---
  if (/\b(what have you learned|what did you learn|show (me )?what you('ve| have) learned)\b/.test(t)) {
    return { intent: "learned", slots: {} };
  }

  // --- sherry: relationship & behavior analysis ---
  // "who do i talk to most" / "who haven't i talked to" / "relationship report"
  if (/\b(relationships?|relationship report|who do i talk to( most)?|who haven'?t i (talked to|heard from)( lately| recently)?|who'?s gone quiet|communication patterns?)\b/.test(t)) {
    return { intent: "relationships", slots: {} };
  }

  // --- sherry: calendar ---
  // "what's on my calendar" / "when's my next meeting" / "what's tomorrow"
  // (before brief: "how's my day" stays with brief)
  if (/\bwhen'?s my next (meeting|event|appointment|call)\b|\bwhat'?s next( on my calendar)?\b|\bnext meeting\b/.test(t)) {
    return { intent: "calendar_next", slots: {} };
  }
  if (/\btomorrow\b/.test(t) && /\b(calendar|schedule|meetings?|events?|look like)\b/.test(t)) {
    return { intent: "calendar_tomorrow", slots: {} };
  }
  if (/\b(what'?s on my calendar|my calendar|my schedule|any meetings? today|today'?s meetings?|today'?s schedule)\b/.test(t)) {
    return { intent: "calendar_today", slots: {} };
  }

  // --- sherry: reminders & timers ---
  // "remind me in 20 minutes to call the bank" / "set a timer for 10 minutes"
  if (/\bcancel\b.*\b(reminders?|timers?)\b|\b(reminders?|timers?)\b.*\bcancel\b/.test(t)) {
    return { intent: "reminder_cancel", slots: {} };
  }
  if (/\b(what are my reminders?|any reminders?|list( my)? reminders?|show( my)? reminders?)\b/.test(t)) {
    return { intent: "reminders_list", slots: {} };
  }
  {
    const m = t.match(/\bremind me\b\s*(.*)$/);
    if (m) return { intent: "remind", slots: { rest: m[1].trim() } };
  }
  {
    const m = t.match(/\b(?:set\s+)?(?:a\s+)?timer\b\s*(?:for\s*)?(.*)$/);
    if (m) return { intent: "timer", slots: { rest: m[1].trim() } };
  }

  // --- sherry: quick capture to abba ---
  // "note: idea for the menu" / "take a note ..." / "jot down ..."
  {
    const m = t.match(/^(?:note|jot down|take a note|write down)\s*:?\s*(.+)$/);
    if (m && m[1].trim().length >= 2) return { intent: "note", slots: { body: m[1].trim() } };
  }

  // --- sherry ↔ loom: durable thinking ---
  // "think about the best pricing model" / "what did loom conclude"
  if (/\b(what did loom conclude|check loom|any thoughts|what are you thinking about|loom status)\b/.test(t)) {
    return { intent: "thoughts", slots: {} };
  }
  {
    const m = t.match(/^(?:think about|loom[,:]?\s*think(?: about)?|ponder|figure out|chew on)\s+(.+)$/);
    if (m && m[1].trim().length >= 3) return { intent: "think", slots: { goal: m[1].trim() } };
  }

  // --- help ---
  if (/\b(help|what can you do|commands)\b/.test(t)) {
    return { intent: "help", slots: {} };
  }

  // --- fuzzy fallback: typo-tolerant, paraphrase-tolerant recovery ---
  // Only runs when no exact pattern matched. Returns "unknown" rather than
  // misrouting when no intent clearly wins.
  const fuzzy = fuzzyRoute(t);
  if (fuzzy) return { intent: fuzzy.intent, slots: fuzzy.slots };

  return { intent: "unknown", slots: {} };
}

/** Spoken help text, kept short for TTS. Covers every intent. */
export const HELP_SPEECH =
  "Brief me, what should I do, relationship report. " +
  "Think about pricing, what did loom conclude. " +
  "Calendar: what's on my calendar, when's my next meeting. " +
  "Remind me in 20, set a timer, note: idea. " +
  "Ascent: what's on my plate, add task milk. " +
  "Relay: message Shy I'll be late, yes to send. " +
  "Switchboard: what's new, next, snooze, dismiss, mute GitHub. " +
  "Longview: research electric cars, what did you find";
