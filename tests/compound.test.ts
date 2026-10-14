// sherry: compound command tests ("brief me and mute github").
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitCompound } from "../src/router";

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
const j = (d: any) => new Response(JSON.stringify(d), { headers: { "content-type": "application/json" } });

let muted: string[] = [];

beforeAll(() => {
  process.env.SHERRY_DATA = mkdtempSync(join(tmpdir(), "sherry-compound-"));
  const briefing = stub({
    "GET /api/weather": () => j({ place: "Cincinnati", current: { temp_c: 20, description: "sunny" } }),
    "GET /api/news": () => j({ items: [] }),
    "GET /api/tasks": () => j({ tasks: [] }),
    "GET /api/mood": () => j({}),
  });
  const sw = stub({
    "GET /api/channels": () => j({ channels: [{ id: "github", label: "GitHub" }] }),
    "GET /api/settings": () => j({ settings: { quiet_enabled: "0" } }),
    "GET /api/notifications": () => j({ notifications: [] }),
    "POST /api/channels/github/snooze": async (req) => {
      muted.push("github");
      return j({ channel: { id: "github" } });
    },
  });
  const ascent = stub({
    "GET /api/myday": () => j({ overdue: [], today: [{ title: "Call bank" }], in_progress: [] }),
  });
  process.env.BRIEFING_URL = briefing;
  process.env.SWITCHBOARD_URL = sw;
  process.env.ASCENT_URL = ascent;
  process.env.RELAY_URL = stub({
    "GET /api/conversations": () => j({
      conversations: [{ id: "c1", title: "Shy", is_group: false, last_channel: "sms", unread: 0, last_body: "", last_at: "", last_direction: "" }],
    }),
  });
  process.env.LONGVIEW_URL = stub({ "GET /api/agent": () => j({ ok: true, runs: [] }) });
});

afterAll(() => { for (const s of stubs) s.stop(); });

const { handle } = await import("../src/app");
const { __resetConversationForTests } = await import("../src/app");

async function ask(text: string) {
  __resetConversationForTests();
  const r = await handle(new Request("http://x/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  }));
  return r.json() as Promise<any>;
}

describe("splitCompound", () => {
  test("splits on conjunctions", () => {
    expect(splitCompound("brief me and mute github")).toEqual(["brief me", "mute github"]);
    expect(splitCompound("what should i do then mute github")).toEqual(["what should i do", "mute github"]);
    expect(splitCompound("brief me, mute github")).toEqual(["brief me", "mute github"]);
  });
  test("returns null without conjunction", () => {
    expect(splitCompound("brief me")).toBeNull();
    expect(splitCompound("message shy hello")).toBeNull();
  });
});

describe("compound commands", () => {
  test("brief me and mute github runs both", async () => {
    muted = [];
    const d: any = await ask("brief me and mute github");
    expect(d.intent).toBe("brief+mute_channel");
    expect(d.speech).toMatch(/20 degrees/);
    expect(d.speech).toMatch(/GitHub.*muted|muted.*GitHub/i);
    expect(muted).toContain("github");
  });

  test("message body with 'and' is not split", async () => {
    // "eggs" alone is unknown, so the compound is rejected and the whole
    // utterance routes as one message command.
    const d: any = await ask("message shy buy milk and eggs");
    expect(d.intent).toBe("message");
    expect(d.speech).toMatch(/buy milk and eggs/);
  });

  test("fuzzy segments recover in compounds", async () => {
    muted = [];
    const d: any = await ask("brif me and mut github");
    expect(d.intent).toBe("brief+mute_channel");
    expect(muted).toContain("github");
  });

  test("myday and suggest chain", async () => {
    const d: any = await ask("what's on my plate and what should i do");
    expect(d.intent).toBe("myday+suggest");
    expect(d.speech).toMatch(/Call bank/);
  });
});
