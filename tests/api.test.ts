// sherry: /api/ask pipeline tests — routing + multi-turn pending, stub backends.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stubs: Array<ReturnType<typeof Bun.serve>> = [];
function stub(routes: Record<string, (req: Request) => Response | Promise<Response>>) {
  const s = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const fn = routes[`${req.method} ${u.pathname}`];
      if (fn) return fn(req);
      return new Response("nf", { status: 404 });
    },
  });
  stubs.push(s);
  return `http://127.0.0.1:${s.port}`;
}

const j = (d: any, st = 200) => new Response(JSON.stringify(d), { status: st, headers: { "content-type": "application/json" } });
let sent: any[] = [];

beforeAll(() => {
  const tmp = mkdtempSync(join(tmpdir(), "sherry-test-"));
  process.env.SHERRY_DATA = tmp;

  const briefing = stub({
    "GET /api/health": () => j({ ok: true }),
    "GET /api/weather": () => j({ place: "Cincinnati", current: { temp_c: 20, description: "sunny" } }),
    "GET /api/news": () => j({ items: [] }),
    "GET /api/tasks": () => j({ tasks: [] }),
    "GET /api/mood": () => j({}),
  });
  const ascent = stub({
    "GET /api/status": () => j({ ok: true }),
    "GET /api/myday": () => j({ overdue: [], today: [], in_progress: [] }),
    "GET /api/projects": () => j({ projects: [{ id: "p1", name: "Work" }] }),
    "POST /api/quick-add": () => j({ ok: true }),
  });
  const relay = stub({
    "GET /api/status": () => j({ ok: true }),
    "GET /api/conversations": () => j({
      conversations: [{ id: "c1", title: "Shy", is_group: false, last_channel: "sms", unread: 0, last_body: "", last_at: "", last_direction: "" }],
    }),
    "POST /api/conversations/c1/messages": async (req) => {
      sent.push(await req.json());
      return j({ ok: true });
    },
  });
  const sw = stub({
    "GET /api/health": () => j({ ok: true }),
    "GET /api/notifications": () => j({
      notifications: [{ id: 3, title: "Deploy done", body: "", channel: "github", status: "new", created_at: 1 }],
    }),
    "POST /api/notifications/3/snooze": () => j({ notification: { id: 3 } }),
  });

  process.env.BRIEFING_URL = briefing;
  process.env.ASCENT_URL = ascent;
  process.env.RELAY_URL = relay;
  process.env.SWITCHBOARD_URL = sw;
});

afterAll(() => { for (const s of stubs) s.stop(); });

const { handle } = await import("../src/app");

async function ask(text: string) {
  const r = await handle(new Request("http://x/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  }));
  return r.json();
}

describe("/api/ask pipeline", () => {
  test("brief me speaks weather", async () => {
    const d: any = await ask("brief me");
    expect(d.intent).toBe("brief");
    expect(d.speech).toMatch(/20 degrees/);
  });

  test("empty myday is charming", async () => {
    const d: any = await ask("what's on my plate");
    expect(d.intent).toBe("myday");
    expect(d.speech).toMatch(/Nothing on your plate/);
  });

  test("add task with single project just works", async () => {
    const d: any = await ask("add task review the contract");
    expect(d.intent).toBe("add_task");
    expect(d.speech).toMatch(/Added/);
  });

  test("message stages pending, yes sends, body preserved", async () => {
    sent = [];
    const staged: any = await ask("message Shy I'll be ten minutes late");
    expect(staged.intent).toBe("message");
    expect(staged.pending).not.toBeNull();
    expect(staged.speech).toMatch(/Ready to sms Shy/);
    expect(staged.speech).toMatch(/ten minutes late/);
    expect(sent).toHaveLength(0); // nothing sent yet
    const done: any = await ask("yes");
    expect(done.intent).toBe("confirm");
    expect(done.speech).toMatch(/Sent to Shy/);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe("i'll be ten minutes late");
  });

  test("message then no cancels", async () => {
    sent = [];
    await ask("message Shy hello");
    const d: any = await ask("no");
    expect(d.speech).toMatch(/Cancelled/);
    expect(sent).toHaveLength(0);
  });

  test("yes with nothing pending says so", async () => {
    const d: any = await ask("yes");
    expect(d.speech).toMatch(/Nothing waiting/);
  });

  test("digest then snooze that", async () => {
    const d: any = await ask("what's new");
    expect(d.intent).toBe("digest");
    expect(d.speech).toMatch(/Deploy done/);
    const s: any = await ask("snooze that for 10 minutes");
    expect(s.intent).toBe("snooze");
    expect(s.speech).toMatch(/Snoozed "Deploy done" for 10 minutes/);
  });

  test("snooze with no context asks for digest first", async () => {
    const { __resetConversationForTests } = await import("../src/app");
    __resetConversationForTests();
    const d: any = await ask("snooze that");
    expect(d.speech).toMatch(/Ask me what's new first/);
  });

  test("help + unknown", async () => {
    expect((await ask("help")).intent).toBe("help");
    const u: any = await ask("recite poetry");
    expect(u.intent).toBe("unknown");
  });

  test("unreachable app degrades", async () => {
    process.env.ASCENT_URL = "http://127.0.0.1:1";
    const d: any = await ask("what's on my plate");
    expect(d.speech).toMatch(/can't reach Ascent/);
  });
});
