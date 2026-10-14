// sherry: calendar skill tests.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route } from "../src/router";
import { parseEvents, parseIcalDate } from "../src/calendar";

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:1
DTSTART:20261014T140000Z
DTEND:20261014T150000Z
SUMMARY:Team standup
LOCATION:Zoom
END:VEVENT
BEGIN:VEVENT
UID:2
DTSTART:20261015T090000Z
DTEND:20261015T100000Z
SUMMARY:1:1 with manager
END:VEVENT
BEGIN:VEVENT
UID:3
DTSTART:20261014T090000Z
DTEND:20261014T093000Z
SUMMARY:Daily sync
RRULE:FREQ=DAILY;COUNT=5
END:VEVENT
END:VCALENDAR`;

describe("ical parsing", () => {
  test("parses single events", () => {
    const evs = parseEvents(ICS, Date.UTC(2026, 9, 14), Date.UTC(2026, 9, 14, 23, 59));
    expect(evs.length).toBe(2); // standup + recurring sync
    expect(evs[0].summary).toBe("Daily sync");
    expect(evs[1].summary).toBe("Team standup");
    expect(evs[1].location).toBe("Zoom");
  });

  test("expands recurring events", () => {
    const evs = parseEvents(ICS, Date.UTC(2026, 9, 14), Date.UTC(2026, 9, 18, 23, 59));
    const syncs = evs.filter((e) => e.summary === "Daily sync");
    expect(syncs.length).toBe(5);
  });

  test("parseIcalDate handles formats", () => {
    expect(parseIcalDate("20261014")).toBe(new Date(2026, 9, 14).getTime());
    expect(parseIcalDate("20261014T140000Z")).toBe(Date.UTC(2026, 9, 14, 14));
    expect(isNaN(parseIcalDate("garbage"))).toBe(true);
  });
});

describe("calendar routing", () => {
  test("calendar phrases route correctly", () => {
    expect(route("what's on my calendar").intent).toBe("calendar_today");
    expect(route("when's my next meeting").intent).toBe("calendar_next");
    expect(route("what's tomorrow look like").intent).toBe("calendar_tomorrow");
    expect(route("any meetings today").intent).toBe("calendar_today");
  });
});

describe("calendar intents", () => {
  const stubs: Array<ReturnType<typeof Bun.serve>> = [];
  beforeAll(() => {
    process.env.SHERRY_DATA = mkdtempSync(join(tmpdir(), "sherry-cal-"));
    const s = Bun.serve({
      port: 0,
      fetch() {
        return new Response(ICS, { headers: { "content-type": "text/calendar" } });
      },
    });
    stubs.push(s);
    process.env.CALENDAR_ICAL_URL = `http://127.0.0.1:${s.port}/cal.ics`;
  });
  afterAll(() => { for (const s of stubs) s.stop(); delete process.env.CALENDAR_ICAL_URL; });

  test("calendarNext finds the next event", async () => {
    const { calendarNext } = await import("../src/calendar");
    // Freeze time to just before the standup
    const realNow = Date.now;
    Date.now = () => Date.UTC(2026, 9, 14, 13, 0);
    try {
      const r = await calendarNext();
      expect(r.ok).toBe(true);
      expect(r.speech).toMatch(/Team standup/);
      expect(r.speech).toMatch(/in 60 minutes|in 1 hours/);
    } finally {
      Date.now = realNow;
    }
  });
});
