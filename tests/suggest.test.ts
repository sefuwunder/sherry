// sherry: suggest analyzer unit tests. The analyze() function itself hits
// live services, so we test the routing + the pure analysis helpers via
// a re-exported test seam.
import { describe, test, expect } from "bun:test";
import { route } from "../src/router";

describe("suggest routing", () => {
  test("suggestion phrases route to suggest", () => {
    for (const t of [
      "suggestions",
      "what should i do",
      "what needs my attention",
      "prioritize",
      "what's important",
      "analyze my day",
      "any suggestions",
    ]) {
      expect(route(t).intent).toBe("suggest");
    }
  });

  test("help mentions suggestions", async () => {
    const { HELP_SPEECH } = await import("../src/router");
    expect(HELP_SPEECH.toLowerCase()).toContain("what should i do");
  });
});

describe("suggest analysis", () => {
  test("relay: flags unanswered inbound waiting 3+ hours", async () => {
    const { analyzeRelay } = await import("../src/suggest");
    const old = new Date(Date.now() - 5 * 3600_000).toISOString();
    const recent = new Date(Date.now() - 30 * 60_000).toISOString();
    const out = analyzeRelay([
      { id: "1", title: "Shy", unread: 2, last_direction: "in", last_at: old },
      { id: "2", title: "Dany", unread: 1, last_direction: "in", last_at: recent },
      { id: "3", title: "Mom", unread: 1, last_direction: "out", last_at: old },
    ]);
    expect(out.length).toBe(1);
    expect(out[0].text).toContain("Shy");
    expect(out[0].text).toContain("5 hours");
    expect(out[0].priority).toBe(2);
  });

  test("ascent: flags overdue and heavy days", async () => {
    const { analyzeAscent } = await import("../src/suggest");
    const out = analyzeAscent({
      overdue: [{ title: "File taxes" }, { title: "Call accountant" }],
      today: Array.from({ length: 6 }, (_, i) => ({ title: `task ${i}` })),
      in_progress: [],
    });
    expect(out.some((s) => s.text.includes("2 overdue"))).toBe(true);
    expect(out.some((s) => s.text.includes("heavy day"))).toBe(true);
  });

  test("ascent: spots project pile-ups", async () => {
    const { analyzeAscent } = await import("../src/suggest");
    const mk = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ title: `t${i}`, project_name: p }));
    const out = analyzeAscent({ overdue: [], today: [...mk(4, "Website"), ...mk(1, "Home")], in_progress: [] });
    expect(out.some((s) => s.text.includes("Website"))).toBe(true);
  });

  test("switchboard: surfaces urgent and noisy channels", async () => {
    const { analyzeSwitchboard } = await import("../src/suggest");
    const notifs = [
      { id: 1, title: "Server down", priority: "urgent", status: "active", channel_id: "ops" },
      ...Array.from({ length: 7 }, (_, i) => ({
        id: 10 + i, title: `pr ${i}`, priority: "normal", status: "active", channel_id: "gh",
      })),
    ];
    const out = analyzeSwitchboard(notifs, [{ id: "gh", label: "GitHub" }]);
    expect(out.some((s) => s.priority === 1 && s.text.includes("Server down"))).toBe(true);
    expect(out.some((s) => s.text.includes("GitHub") && s.text.includes("7 notifications"))).toBe(true);
    expect(out.some((s) => s.action?.includes("mute github"))).toBe(true);
  });

  test("switchboard: ignores dismissed and snoozed", async () => {
    const { analyzeSwitchboard } = await import("../src/suggest");
    const notifs = Array.from({ length: 8 }, (_, i) => ({
      id: i, title: `n${i}`, priority: "normal", status: "dismissed", channel_id: "gh",
    }));
    const out = analyzeSwitchboard(notifs, []);
    expect(out.length).toBe(0);
  });
});

describe("jev feedback loop", () => {
  test("acting on a suggestion raises its kind weight", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "sherry-fb-"));
    process.env.SHERRY_DATA = tmp;

    const j = (d: any) => new Response(JSON.stringify(d), { headers: { "content-type": "application/json" } });
    const mk = (routes: any) => {
      const s = Bun.serve({
        port: 0,
        fetch(req) {
          const u = new URL(req.url);
          const fn = routes[`GET ${u.pathname}`] || routes[`POST ${u.pathname}`];
          return fn ? fn(req) : new Response("nf", { status: 404 });
        },
      });
      return { url: `http://127.0.0.1:${s.port}`, stop: () => s.stop() };
    };
    // 7 notifications from github -> noisy_channel suggestion with "mute github" action
    const notifs = Array.from({ length: 7 }, (_, i) => ({
      id: 100 + i, title: `CI ${i}`, body: "", channel_id: "github", priority: "normal", status: "new", created_at: 1000 + i,
    }));
    const sw = mk({
      "GET /api/notifications": () => j({ notifications: notifs }),
      "GET /api/channels": () => j({ channels: [{ id: "github", label: "GitHub" }] }),
      "POST /api/channels/github/snooze": () => j({ channel: { id: "github" } }),
    });
    const relay = mk({ "GET /api/conversations": () => j({ conversations: [] }) });
    const ascent = mk({ "GET /api/myday": () => j({ overdue: [], today: [], in_progress: [] }) });
    process.env.SWITCHBOARD_URL = sw.url;
    process.env.RELAY_URL = relay.url;
    process.env.ASCENT_URL = ascent.url;

    const { __resetDbForTests } = await import("../src/db");
    const { __resetJevForTests, kindWeight } = await import("../src/jev");
    const { __resetConversationForTests, handle } = await import("../src/app");
    __resetDbForTests();
    __resetJevForTests();
    __resetConversationForTests();

    const ask = async (text: string) => {
      const r = await handle(new Request("http://x/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }));
      return r.json() as Promise<any>;
    };

    // Baseline: no evidence yet
    expect(kindWeight("noisy_channel")).toBe(0.5);

    // Get suggestions -> offers noisy_channel, records shown
    const s: any = await ask("what should I do");
    expect(s.intent).toBe("suggest");
    expect(s.speech).toMatch(/GitHub/);
    expect(s.speech).toMatch(/mute github/);
    // shown=1, acted=0 -> (0+1)/(1+2) = 1/3
    expect(kindWeight("noisy_channel")).toBeCloseTo(1 / 3, 5);

    // Act on it -> records acted
    const m: any = await ask("mute github");
    expect(m.intent).toBe("mute_channel");
    // shown=1, acted=1 -> (1+1)/(1+2) = 2/3
    expect(kindWeight("noisy_channel")).toBeCloseTo(2 / 3, 5);

    sw.stop(); relay.stop(); ascent.stop();
  });

  test("learned intent reports patterns", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "sherry-fb2-"));
    process.env.SHERRY_DATA = tmp;
    const { __resetDbForTests } = await import("../src/db");
    const { __resetJevForTests, recordShown, recordActed } = await import("../src/jev");
    const { __resetConversationForTests, handle } = await import("../src/app");
    __resetDbForTests();
    __resetJevForTests();
    __resetConversationForTests();

    const ask = async (text: string) => {
      const r = await handle(new Request("http://x/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }));
      return r.json() as Promise<any>;
    };

    const d: any = await ask("what have you learned");
    expect(d.intent).toBe("learned");
    expect(d.speech).toMatch(/haven't learned/);

    recordShown("waiting_reply");
    recordShown("waiting_reply");
    recordActed("waiting_reply");
    recordActed("waiting_reply");
    const d2: any = await ask("what have you learned");
    expect(d2.speech).toMatch(/usually act/);
  });
});
