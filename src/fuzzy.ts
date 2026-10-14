// sherry: fuzzy command understanding. When the exact regex router returns
// "unknown", this layer tries to recover the intent deterministically:
// typo-tolerant verb matching (bounded Levenshtein), keyword-profile scoring
// with stemming, and positional slot extraction. No LLM, no network.
//
// Design: exact regexes stay the fast precise path. Fuzzy only runs on
// "unknown", and only fires when one intent clearly wins (margin threshold),
// so it degrades to "unknown" rather than misrouting.

import type { IntentName, Route } from "./router";

/** Bounded Levenshtein: exact distance up to maxDist, else maxDist+1. */
export function boundedEdit(a: string, b: string, maxDist: number): number {
  if (a === b) return 0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > maxDist) return maxDist + 1;
  let prev = new Array<number>(lb + 1);
  let cur = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[lb] <= maxDist ? prev[lb] : maxDist + 1;
}

/** Light stemmer so "briefing"/"briefed" match "brief". */
export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

const STOP = new Set(
  "a,an,the,and,or,but,of,to,in,on,for,with,at,by,from,as,is,are,was,were,be,been,being,it,its,this,that,these,those,i,you,he,she,we,they,them,his,her,our,your,their,what,which,who,whom,how,when,where,why,do,does,did,can,could,should,would,will,just,not,no,yes,if,then,than,so,such,into,over,after,before,between,about,up,out,more,most,other,some,any,all,only,very,too,please,could,you,me,my".split(",")
);

function tokens(t: string): string[] {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP.has(w))
    .map(stem);
}

interface IntentProfile {
  intent: IntentName;
  /** Command verbs; matched with typo tolerance (edit distance <= 1, or <= 2 for long words). */
  verbs: string[];
  /** Characteristic keywords (stemmed at match time) for profile scoring. */
  keywords: string[];
  /** Multi-word phrases that strongly signal this intent (matched literally). */
  phrases?: string[];
  /** Extract slots given the token index of the matched verb. */
  slots?: (words: string[], verbIdx: number) => Record<string, string> | null;
}

function afterVerb(words: string[], verbIdx: number, n: number): string[] {
  return words.slice(verbIdx + 1, verbIdx + 1 + n);
}

const PROFILES: IntentProfile[] = [
  {
    intent: "brief",
    verbs: ["brief", "briefing", "rundown"],
    keywords: ["brief", "morning", "rundown", "headlines", "news", "weather", "overview", "recap"],
  },
  {
    intent: "suggest",
    verbs: ["suggest", "prioritize", "prioritise", "analyze", "analyse", "advice"],
    keywords: ["suggest", "advice", "recommend", "prioritize", "important", "attention", "focus", "should"],
    phrases: ["what to do", "what should i"],
  },
  {
    intent: "learned",
    verbs: ["learned", "learnt"],
    keywords: ["learned", "learnt", "patterns", "habits"],
  },
  {
    intent: "myday",
    verbs: ["plate", "tasks", "agenda", "schedule", "todo"],
    keywords: ["plate", "tasks", "today", "agenda", "schedule", "todo", "overdue", "due"],
  },
  {
    intent: "add_task",
    verbs: ["add", "create", "remind"],
    keywords: ["add", "create", "task", "todo", "remind", "remember"],
    slots: (words, verbIdx) => {
      let rest = words.slice(verbIdx + 1).join(" ");
      // strip a leading "task"/"a task"
      rest = rest.replace(/^(a )?task /, "").trim();
      const pm = rest.match(/^(.+?) (?:to|in|for) ([a-z0-9][a-z0-9 _-]*)$/);
      if (pm) return { title: pm[1].trim(), project: pm[2].trim() };
      if (!rest) return null;
      return { title: rest };
    },
  },
  {
    intent: "message",
    verbs: ["message", "text", "tell", "send", "dm"],
    keywords: ["message", "text", "tell", "send", "dm", "reply"],
    slots: (words, verbIdx) => {
      const rest = afterVerb(words, verbIdx, 2);
      if (rest.length < 2) return null;
      const contact = rest[0];
      if (/^(me|myself|us)$/.test(contact)) return null;
      const body = words.slice(verbIdx + 2).join(" ");
      if (!body) return null;
      return { contact, body };
    },
  },
  {
    intent: "new_messages",
    verbs: ["unread", "messages", "texts"],
    keywords: ["unread", "new", "messages", "texts", "inbox", "missed"],
  },
  {
    intent: "digest",
    verbs: ["digest", "notifications", "alerts", "updates", "happening"],
    keywords: ["new", "urgent", "notifications", "alerts", "updates", "happening", "happen", "digest", "going"],
  },
  {
    intent: "snooze",
    verbs: ["snooze", "snez", "later"],
    keywords: ["snooze", "later", "remind"],
  },
  {
    intent: "dismiss",
    verbs: ["dismiss", "dismissed", "ignore", "clear"],
    keywords: ["dismiss", "ignore", "clear", "drop", "done"],
  },
  {
    intent: "mute_channel",
    verbs: ["mute", "silence", "quiet"],
    keywords: ["mute", "silence", "quiet", "channel"],
    slots: (words, verbIdx) => {
      const rest = words.slice(verbIdx + 1).join(" ").replace(/ for (today|\d+.*)$/, "").trim();
      if (!rest) return null;
      return { channel: rest };
    },
  },
  {
    intent: "unmute_channel",
    verbs: ["unmute"],
    keywords: ["unmute", "unblock", "restore"],
    slots: (words, verbIdx) => {
      const rest = words.slice(verbIdx + 1).join(" ").trim();
      if (!rest) return null;
      return { channel: rest };
    },
  },
  {
    intent: "research_start",
    verbs: ["research", "investigate", "explore", "look"],
    keywords: ["research", "investigate", "look", "explore", "dig", "into"],
    slots: (words, verbIdx) => {
      let rest = words.slice(verbIdx + 1).join(" ");
      rest = rest.replace(/^(into|about|on|up) /, "").trim();
      if (!rest || /^(status|update)$/.test(rest)) return null;
      return { topic: rest };
    },
  },
  {
    intent: "research_status",
    verbs: ["status"],
    keywords: ["status", "research", "running", "progress", "update"],
  },
  {
    intent: "research_findings",
    verbs: ["findings", "found"],
    keywords: ["find", "findings", "found", "results", "summarize", "summary", "report"],
    slots: (words, verbIdx) => {
      const rest = words.slice(verbIdx + 1).join(" ").replace(/^(on|about) /, "").trim();
      return rest ? { topic: rest } : {};
    },
  },
  {
    intent: "help",
    verbs: ["help", "commands"],
    keywords: ["help", "commands", "what", "can", "do"],
  },
];

/** Max edit distance scaled by word length: 1 for short, 2 for long words. */
function typoBudget(word: string): number {
  return word.length >= 6 ? 2 : 1;
}

interface Scored {
  profile: IntentProfile;
  score: number;
  verbIdx: number;
  verbDist: number;
}

/**
 * Fuzzy route: returns the best intent when one clearly wins, else null.
 * Scoring: verb match (exact=3, typo=2) + keyword hits (1 each, stemmed).
 * Requires a verb hit OR >= 2 keyword hits, and a margin of >= 1.5 over
 * the runner-up, to avoid misrouting.
 */
export function fuzzyRoute(t: string): (Route & { confidence: number }) | null {
  const words = t.toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const toks = new Set(tokens(t));

  const scored: Scored[] = [];
  for (const p of PROFILES) {
    let bestVerb = -1;
    let bestDist = 99;
    let verbIdx = -1;
    for (let i = 0; i < words.length; i++) {
      for (const v of p.verbs) {
        const d = boundedEdit(words[i], v, typoBudget(v));
        if (d <= typoBudget(v) && d < bestDist) {
          bestDist = d;
          bestVerb = d === 0 ? 3 : 2;
          verbIdx = i;
        }
      }
    }
    let kwHits = 0;
    for (const k of p.keywords) {
      if (toks.has(stem(k))) kwHits++;
    }
    // Phrases count double: they're strong, specific signals.
    let phraseHits = 0;
    if (p.phrases) {
      const lower = t.toLowerCase();
      for (const ph of p.phrases) {
        if (lower.includes(ph)) phraseHits += 2;
      }
    }
    const score = (bestVerb > 0 ? bestVerb : 0) + kwHits + phraseHits;
    // Gate: need a verb hit, a phrase hit, or at least 2 keyword hits.
    if (bestVerb <= 0 && phraseHits === 0 && kwHits < 2) continue;
    scored.push({ profile: p, score, verbIdx, verbDist: bestDist });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || a.verbDist - b.verbDist);
  const [top, runner] = scored;
  // Margin: must clearly beat the runner-up. A strictly closer verb match
  // breaks ties (e.g. "mesage" is dist 1 from "message" but dist 2 from
  // "messages"); otherwise require a clear score margin to avoid misrouting.
  if (runner && !(top.verbDist < runner.verbDist) && top.score - runner.score < 1.5) return null;

  // Try profiles in rank order; a slot-extraction failure skips to the next
  // (e.g. "tell me what to do": "tell" matches message but has no valid
  // contact, so fall through to suggest via the "what to do" phrase).
  for (const cand of scored) {
    const slots = cand.profile.slots && cand.verbIdx >= 0
      ? cand.profile.slots(words, cand.verbIdx)
      : {};
    if (slots === null) continue;
    const confidence = Math.min(1, cand.score / 6);
    return { intent: cand.profile.intent, slots: slots || {}, confidence };
  }
  return null;
}
