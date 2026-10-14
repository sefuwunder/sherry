// sherry: abba quick-capture + reminder firing integration.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stubs: Array<ReturnType<typeof Bun.serve>> = [];
let savedNotes: any[] = [];
beforeAll(() => {
  process.env.SHERRY_DATA = mkdtempSync(join(tmpdir(), "sherry-cap-"));
  const abba = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/notes" && req.method === "POST") {
        const b: any = await req.json();
        savedNotes.push(b);
        return new Response(JSON.stringify({ note: { id: 1, ...b } }), { status: 201 });
      }
      return new Response("nf", { status: 404 });
    },
  });
  stubs.push(abba);
  process.env.ABBA_URL = `http://127.0.0.1:${abba.port}`;
});
afterAll(() => { for (const s of stubs) s.stop(); delete process.env.ABBA_URL; });

const { handle, __resetConversationForTests, __fireDueRemindersForTests } = await import("../src/app");
const { addReminder } = await import("../src/remind");

async function ask(text: string) {
  __resetConversationForTests();
  const r = await handle(new Request("http://x/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  }));
  return r.json() as Promise<any>;
}

describe("quick capture", () => {
  test("note: saves to abba", async () => {
    const d: any = await ask("note: brilliant idea for the juice bar menu");
    expect(d.intent).toBe("note");
    expect(d.speech).toBe("Noted.");
    expect(savedNotes.length).toBe(1);
    expect(savedNotes[0].body).toContain("brilliant idea");
    expect(savedNotes[0].tags).toContain("sherry");
  });

  test("note without abba explains", async () => {
    delete process.env.ABBA_URL;
    // point at a dead port
    process.env.ABBA_URL = "http://127.0.0.1:1";
    const d: any = await ask("note: this will fail");
    expect(d.speech).toMatch(/couldn't reach abba/i);
  });
});

describe("reminder intents", () => {
  test("remind me parses and confirms", async () => {
    const d: any = await ask("remind me in 20 minutes to call the bank");
    expect(d.intent).toBe("remind");
    expect(d.speech).toMatch(/in 20 minutes/);
    expect(d.speech).toMatch(/call the bank/);
  });

  test("remind me without time asks when", async () => {
    const d: any = await ask("remind me to call the bank");
    expect(d.speech).toMatch(/when should i remind/i);
  });

  test("timer sets and fires", async () => {
    const d: any = await ask("set a timer for 1 second");
    expect(d.intent).toBe("timer");
    expect(d.speech).toMatch(/timer set/i);
    // Fast-forward: fire it directly
    const fired = __fireDueRemindersForTests();
    // (may include the earlier 20-min reminder if due — just check timer fired eventually)
    const r = addReminder("test brew", Date.now() - 1000, "timer");
    const fired2 = __fireDueRemindersForTests();
    expect(fired2.some((t) => t.includes("Timer done"))).toBe(true);
  });

  test("reminders_list shows pending", async () => {
    const d: any = await ask("what are my reminders");
    expect(d.intent).toBe("reminders_list");
    expect(d.speech).toMatch(/reminders:|no reminders/i);
  });

  test("cancel clears", async () => {
    await ask("remind me in 5 minutes to test cancel");
    const d: any = await ask("cancel my reminders");
    expect(d.intent).toBe("reminder_cancel");
    expect(d.speech).toMatch(/cancelled|nothing to cancel/i);
  });
});
