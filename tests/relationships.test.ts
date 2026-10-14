// sherry: relationship & behavior analysis tests.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route } from "../src/router";

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

const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
// Shy: high volume, fast replies, SMS only. Dany: quiet for 20 days.
function msgs(name: string): any[] {
  if (name === "shy") {
    const out = [];
    for (let d = 0; d < 10; d++) {
      out.push({ direction: "in", channel: "sms", created_at: iso(d) });
      out.push({ direction: "out", channel: "sms", created_at: iso(d - 0.05) });
    }
    return out;
  }
  if (name === "dany") {
    return [
      { direction: "in", channel: "email", created_at: iso(20) },
      { direction: "out", channel: "email", created_at: iso(19.9) },
      { direction: "in", channel: "email", created_at: iso(25) },
      { direction: "out", channel: "email", created_at: iso(24.8) },
      { direction: "in", channel: "email", created_at: iso(30) },
    ];
  }
  return [];
}

beforeAll(() => {
  process.env.SHERRY_DATA = mkdtempSync(join(tmpdir(), "sherry-rel-"));
  const relay = stub({
    "GET /api/conversations": () => j({
      conversations: [
        { id: "c1", title: "Shy", is_group: false, last_at: iso(0), last_channel: "sms", last_direction: "out", unread: 0 },
        { id: "c2", title: "Dany", is_group: false, last_at: iso(20), last_channel: "email", last_direction: "in", unread: 0 },
      ],
    }),
    "GET /api/conversations/c1/messages": () => j({ messages: msgs("shy") }),
    "GET /api/conversations/c2/messages": () => j({ messages: msgs("dany") }),
  });
  process.env.RELAY_URL = relay;
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

describe("relationships routing", () => {
  test("relationship phrases route correctly", () => {
    for (const t of [
      "relationship report",
      "who do i talk to most",
      "who haven't i talked to",
      "who's gone quiet",
    ]) {
      expect(route(t).intent).toBe("relationships");
    }
  });
});

describe("relationship analysis", () => {
  test("report names most-active and neglected", async () => {
    const d: any = await ask("relationship report");
    expect(d.intent).toBe("relationships");
    expect(d.speech).toMatch(/Shy/);
    expect(d.speech).toMatch(/Dany/);
    expect(d.speech).toMatch(/quiet|weeks ago/);
  });

  test("compound with relationships", async () => {
    const d: any = await ask("brief me and relationship report");
    expect(d.intent).toBe("brief+relationships");
  });
});
