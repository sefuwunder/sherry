// sherry: minimal iCal reader for the calendar skill. Fetches the user's
// calendar feed (CALENDAR_ICAL_URL, the same secret iCal URL used by
// Switchboard) and answers "what's on today", "when's my next meeting", etc.
// Parses VEVENTs with a small footprint: DTSTART/DTEND/SUMMARY/LOCATION plus
// simple DAILY/WEEKLY RRULE expansion. No deps.

export interface CalEvent {
  summary: string;
  location: string;
  startMs: number;
  endMs: number;
}

function dataDir(): string {
  // no persistence needed; feed is fetched live
  return "";
}

/** Unfold iCal line continuations (lines starting with space/tab). */
function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && out.length) out[out.length - 1] += raw.slice(1);
    else out.push(raw);
  }
  return out;
}

interface RawEvent {
  summary: string;
  location: string;
  dtstart: string;
  dtend: string;
  rrule: string;
}

/** Parse an iCal datetime to ms. Handles UTC (Z), floating local, and date-only. */
export function parseIcalDate(s: string): number {
  // Date-only: 20261014 -> local midnight
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  // UTC: 20261014T153000Z
  m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // Floating/local: 20261014T153000 -> local time
  m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return NaN;
}

function parseRrule(rrule: string): { freq: string; count: number; untilMs: number } | null {
  const freq = /FREQ=(DAILY|WEEKLY)/.exec(rrule)?.[1];
  if (!freq) return null;
  const count = Number(/COUNT=(\d+)/.exec(rrule)?.[1] || 0);
  const untilStr = /UNTIL=([^;]+)/.exec(rrule)?.[1];
  const untilMs = untilStr ? parseIcalDate(untilStr) : Infinity;
  return { freq, count, untilMs };
}

/** Expand one raw event into occurrences within [fromMs, toMs]. */
function expand(ev: RawEvent, fromMs: number, toMs: number): CalEvent[] {
  const start = parseIcalDate(ev.dtstart);
  if (isNaN(start)) return [];
  const end = ev.dtend ? parseIcalDate(ev.dtend) : start + 3600_000;
  const dur = Math.max(0, end - start);
  const out: CalEvent[] = [];
  const push = (s: number) => {
    if (s >= fromMs && s <= toMs) {
      out.push({ summary: ev.summary || "(untitled)", location: ev.location, startMs: s, endMs: s + dur });
    }
  };

  const rule = ev.rrule ? parseRrule(ev.rrule) : null;
  if (!rule) {
    push(start);
    return out;
  }
  const step = rule.freq === "DAILY" ? 86_400_000 : 7 * 86_400_000;
  // Fast-forward to the window to avoid huge loops.
  let n = 0;
  if (start < fromMs) n = Math.floor((fromMs - start) / step);
  const maxIter = rule.count > 0 ? Math.min(rule.count, 366) : 366;
  for (let i = n; i < maxIter; i++) {
    const s = start + i * step;
    if (s > toMs || s > rule.untilMs) break;
    if (rule.count > 0 && i >= rule.count) break;
    push(s);
  }
  return out;
}

export function parseEvents(text: string, fromMs: number, toMs: number): CalEvent[] {
  const lines = unfold(text);
  const events: CalEvent[] = [];
  let cur: RawEvent | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = { summary: "", location: "", dtstart: "", dtend: "", rrule: "" };
    } else if (line === "END:VEVENT" && cur) {
      events.push(...expand(cur, fromMs, toMs));
      cur = null;
    } else if (cur) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const key = line.slice(0, idx).split(";")[0];
      const val = line.slice(idx + 1).replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/gi, " ");
      if (key === "SUMMARY") cur.summary = val;
      else if (key === "LOCATION") cur.location = val;
      else if (key === "DTSTART") cur.dtstart = val;
      else if (key === "DTEND") cur.dtend = val;
      else if (key === "RRULE") cur.rrule = val;
    }
  }
  return events.sort((a, b) => a.startMs - b.startMs);
}

async function fetchFeed(): Promise<{ ok: boolean; text?: string; error?: string }> {
  const url = (process.env.CALENDAR_ICAL_URL || "").trim();
  if (!url) return { ok: false, error: "no_url" };
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "sherry/1.0", Accept: "text/calendar" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true, text: await r.text() };
  } catch {
    return { ok: false, error: "fetch_failed" };
  }
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, "0")}${ap}` : `${h}${ap}`;
}

function fmtEvent(e: CalEvent): string {
  const when = fmtTime(e.startMs);
  const where = e.location ? ` at ${e.location.slice(0, 40)}` : "";
  return `${e.summary} at ${when}${where}`;
}

export interface CalendarResult {
  ok: boolean;
  speech: string;
  events: CalEvent[];
}

async function getEvents(fromMs: number, toMs: number): Promise<CalendarResult> {
  const f = await fetchFeed();
  if (!f.ok) {
    const msg = f.error === "no_url"
      ? "No calendar connected. Set CALENDAR_ICAL_URL to your iCal feed URL."
      : "I couldn't reach your calendar feed.";
    return { ok: false, speech: msg, events: [] };
  }
  const events = parseEvents(f.text!, fromMs, toMs);
  return { ok: true, speech: "", events };
}

/** "What's on my calendar today?" */
export async function calendarToday(): Promise<CalendarResult> {
  const now = Date.now();
  const r = await getEvents(startOfDay(now), startOfDay(now) + 86_400_000 - 1);
  if (!r.ok) return r;
  if (!r.events.length) return { ok: true, speech: "Nothing on your calendar today.", events: [] };
  const bits = r.events.slice(0, 5).map(fmtEvent);
  const more = r.events.length > 5 ? `, plus ${r.events.length - 5} more` : "";
  return { ok: true, speech: `Today: ${bits.join("; ")}${more}.`, events: r.events };
}

/** "What's tomorrow look like?" */
export async function calendarTomorrow(): Promise<CalendarResult> {
  const now = Date.now();
  const tmr = startOfDay(now) + 86_400_000;
  const r = await getEvents(tmr, tmr + 86_400_000 - 1);
  if (!r.ok) return r;
  if (!r.events.length) return { ok: true, speech: "Nothing on your calendar tomorrow.", events: [] };
  const bits = r.events.slice(0, 5).map(fmtEvent);
  return { ok: true, speech: `Tomorrow: ${bits.join("; ")}.`, events: r.events };
}

/** "When's my next meeting?" — next event from now. */
export async function calendarNext(): Promise<CalendarResult> {
  const now = Date.now();
  const r = await getEvents(now - 5 * 60000, now + 7 * 86_400_000);
  if (!r.ok) return r;
  const upcoming = r.events.filter((e) => e.endMs > now);
  if (!upcoming.length) return { ok: true, speech: "Nothing coming up in the next week.", events: [] };
  const e = upcoming[0];
  const mins = Math.round((e.startMs - now) / 60000);
  const when = mins <= 1 ? "right now" : mins < 60 ? `in ${mins} minutes` : `in ${Math.round(mins / 60)} hours`;
  const where = e.location ? ` at ${e.location.slice(0, 40)}` : "";
  return { ok: true, speech: `Next up: ${e.summary} ${when} (${fmtTime(e.startMs)}${where}).`, events: [e] };
}
