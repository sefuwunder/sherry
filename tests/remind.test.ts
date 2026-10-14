// sherry: reminders & timers tests.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route } from "../src/router";
import {
  parseTimeSpec, addReminder, popDue, listPending, cancelAll, fmtWhen, clearFired,
} from "../src/remind";

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sherry-remind-"));
  process.env.SHERRY_DATA = dir;
});
afterAll(() => { try { clearFired(); } catch {} try { rmSync(dir, { recursive: true }); } catch {} });

describe("parseTimeSpec", () => {
  const now = Date.UTC(2026, 9, 14, 12, 0, 0); // noon UTC
  test("in N minutes", () => {
    const r = parseTimeSpec("in 20 minutes to call the bank", now);
    expect(r?.fireAtMs).toBe(now + 20 * 60_000);
    expect(r?.text).toBe("to call the bank");
  });
  test("in an hour", () => {
    const r = parseTimeSpec("in an hour", now);
    expect(r?.fireAtMs).toBe(now + 3_600_000);
  });
  test("at 3pm today", () => {
    const r = parseTimeSpec("at 3pm to stand up", now);
    const d = new Date(r!.fireAtMs);
    expect(d.getHours()).toBe(15); // local time
    expect(r?.text).toBe("to stand up");
  });
  test("past time rolls to tomorrow", () => {
    const r = parseTimeSpec("at 9am", now); // 9am already passed at noon
    expect(r!.fireAtMs).toBeGreaterThan(now);
  });
  test("tomorrow at 9am", () => {
    const r = parseTimeSpec("tomorrow at 9am to review", now);
    expect(r!.fireAtMs).toBeGreaterThan(now + 20 * 3_600_000);
    expect(r?.text).toBe("to review");
  });
  test("no time returns null", () => {
    expect(parseTimeSpec("call the bank", now)).toBeNull();
  });
});

describe("reminder store", () => {
  test("add, list, pop due", () => {
    cancelAll();
    const r = addReminder("call the bank", Date.now() + 60_000, "reminder");
    expect(r.text).toBe("call the bank");
    expect(listPending().length).toBe(1);
    // Not due yet
    expect(popDue(Date.now()).length).toBe(0);
    // Due now
    const due = popDue(Date.now() + 120_000);
    expect(due.length).toBe(1);
    expect(due[0].text).toBe("call the bank");
    expect(listPending().length).toBe(0);
  });
  test("cancelAll clears pending", () => {
    addReminder("x", Date.now() + 60_000);
    addReminder("y", Date.now() + 120_000);
    expect(cancelAll()).toBe(2);
    expect(listPending().length).toBe(0);
  });
});

describe("fmtWhen", () => {
  test("relative times", () => {
    const now = Date.now();
    expect(fmtWhen(now + 30_000, now)).toBe("in a minute");
    expect(fmtWhen(now + 20 * 60_000, now)).toBe("in 20 minutes");
    expect(fmtWhen(now + 2 * 3_600_000, now)).toBe("in 2 hours");
  });
});

describe("reminder routing", () => {
  test("reminder/timer/note phrases route correctly", () => {
    expect(route("remind me in 20 minutes to call the bank").intent).toBe("remind");
    expect(route("set a timer for 10 minutes").intent).toBe("timer");
    expect(route("what are my reminders").intent).toBe("reminders_list");
    expect(route("cancel my reminders").intent).toBe("reminder_cancel");
    expect(route("note: brilliant idea for the menu").intent).toBe("note");
    expect(route("take a note call mom tomorrow").intent).toBe("note");
    expect(route("jot down pick up milk").intent).toBe("note");
  });
  test("slots carry the payload", () => {
    expect(route("remind me in 20 minutes to call").slots.rest).toBe("in 20 minutes to call");
    expect(route("note: hello world").slots.body).toBe("hello world");
  });
});
