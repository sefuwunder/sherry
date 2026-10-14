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
