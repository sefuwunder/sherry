// sherry: client tests against stub app servers (no real integrations needed).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

const stubs: Array<ReturnType<typeof Bun.serve>> = [];

function stub(routes: Record<string, (req: Request) => Response | Promise<Response>>) {
  const s = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const fn = routes[`${req.method} ${u.pathname}`] || routes[`${req.method} *`];
      if (fn) return fn(req);
      return new Response("nf", { status: 404 });
    },
  });
  stubs.push(s);
  return `http://127.0.0.1:${s.port}`;
}

let B = { briefing: "", ascent: "", relay: "", switchboard: "" };

beforeAll(() => {
  const j = (d: any, st = 200) => new Response(JSON.stringify(d), { status: st, headers: { "content-type": "application/json" } });

  B.briefing = stub({
    "GET /api/health": () => j({ ok: true }),
    "GET /api/weather": () => j({ place: "Cincinnati", current: { temp_c: 17, description: "partly cloudy" } }),
    "GET /api/news": () => j({ items: [{ title: "Markets rally" }, { title: "New park opens" }] }),
    "GET /api/tasks": () => j({ tasks: [{ title: "Call bank", status: "open" }, { title: "Done thing", status: "done" }] }),
    "GET /api/mood": () => j({ hn: 5, guardian: -3 }),
  });
  B.ascent = stub({
    "GET /api/status": () => j({ ok: true }),
    "GET /api/myday": () => j({ overdue: [{ title: "Pay rent" }], today: [{ title: "Call bank" }, { title: "Gym" }], in_progress: [] }),
    "GET /api/projects": () => j({ projects: [{ id: "p1", name: "Groceries" }, { id: "p2", name: "Work" }] }),
    "POST /api/quick-add": async (req) => {
      const b: any = await req.json();
      return b.project_id === "p1" && b.text ? j({ ok: true, id: "t9" }) : j({ error: "bad" }, 400);
    },
  });
  B.relay = stub({
    "GET /api/status": () => j({ ok: true }),
    "GET /api/conversations": () => j({
      conversations: [
        { id: "c1", title: "Shy", is_group: false, last_channel: "sms", unread: 2, last_body: "on my way", last_at: "x", last_direction: "in" },
        { id: "c2", title: "Danyetta", is_group: false, last_channel: "sms", unread: 0, last_body: "thanks", last_at: "x", last_direction: "out" },
      ],
    }),
    "POST /api/conversations/c1/messages": async (req) => {
      const b: any = await req.json();
      return b.body ? j({ ok: true, id: "m1" }) : j({ error: "empty" }, 400);
    },
  });
  B.switchboard = stub({
    "GET /api/health": () => j({ ok: true }),
    "GET /api/channels": () => j({
      channels: [
        { id: "github", mode: "instant", enabled: 1, min_priority: "low", snoozed_until: 0, meta: { label: "GitHub" } },
        { id: "news", mode: "muted", enabled: 1, min_priority: "low", snoozed_until: 0, meta: { label: "News" } },
        { id: "cal", mode: "instant", enabled: 1, min_priority: "low", snoozed_until: Date.now() + 3600000, meta: { label: "Calendar" } },
      ],
    }),
    "GET /api/settings": () => j({
      settings: { quiet_enabled: "1", quiet_start: "22:00", quiet_end: "07:00", urgent_breaks_quiet: "1" },
    }),
    "GET /api/notifications": () => j({
      notifications: [
        { id: 7, title: "Build failed", body: "ci red", channel_id: "github", priority: "high", status: "new", created_at: 1000 },
        { id: 8, title: "Old news", body: "", channel_id: "news", priority: "normal", status: "new", created_at: 2000 },
        { id: 9, title: "Meeting soon", body: "", channel_id: "cal", priority: "urgent", status: "new", created_at: 3000 },
        { id: 10, title: "Server down", body: "prod", channel_id: "github", priority: "urgent", status: "new", created_at: 4000 },
        { id: 11, title: "Gone", body: "", channel_id: "github", priority: "normal", status: "dismissed", created_at: 5000 },
      ],
    }),
    "POST /api/notifications/7/snooze": () => j({ notification: { id: 7, status: "snoozed" } }),
    "POST /api/notifications/7/dismiss": () => j({ notification: { id: 7, status: "dismissed" } }),
    "POST /api/channels/github/snooze": async (req) => {
      const b: any = await req.json();
      return j({ channel: { id: "github", snoozed: b.clear ? false : true, minutes: b.minutes } });
    },
  });

  process.env.BRIEFING_URL = B.briefing;
  process.env.ASCENT_URL = B.ascent;
  process.env.RELAY_URL = B.relay;
  process.env.SWITCHBOARD_URL = B.switchboard;
  process.env.BRIEFING_CITY = "Cincinnati";
});

afterAll(() => { for (const s of stubs) s.stop(); });

// Import after env is set — clients read env per call, so order is safe,
// but keep the dynamic import to be explicit.
const C = await import("../src/clients");

describe("clients", () => {
  test("integrationStatus reports all reachable", async () => {
    const st = await C.integrationStatus();
    expect(st).toHaveLength(4);
    expect(st.every((s) => s.reachable)).toBe(true);
  });

  test("composeBrief speaks weather + tasks + headlines", async () => {
    const r = await C.composeBrief();
    expect(r.ok).toBe(true);
    expect(r.speech).toMatch(/17 degrees/);
    expect(r.speech).toMatch(/partly cloudy/);
    expect(r.speech).toMatch(/1 open task/);
    expect(r.speech).toMatch(/Markets rally/);
  });

  test("myDay summarizes groups", async () => {
    const r = await C.myDay();
    expect(r.ok).toBe(true);
    expect(r.speech).toMatch(/3 tasks/);
    expect(r.speech).toMatch(/Pay rent/);
  });

  test("addTask matches project, refuses unknown", async () => {
    const ok = await C.addTask("buy milk", "groceries");
    expect(ok.ok).toBe(true);
    expect(ok.speech).toMatch(/Groceries/);
    const bad = await C.addTask("buy milk", "nope");
    expect(bad.ok).toBe(false);
    expect(bad.speech).toMatch(/don't know the project/);
  });

  test("relay: find + send + unread", async () => {
    const f = await C.findConversation("shy");
    expect(f.ok).toBe(true);
    expect(f.conv!.id).toBe("c1");
    const missing = await C.findConversation("nobody");
    expect(missing.ok).toBe(false);
    const s = await C.sendMessage("c1", "sms", "hello");
    expect(s.ok).toBe(true);
    const u = await C.unreadMessages();
    expect(u.speech).toMatch(/2 from Shy/);
  });

  test("switchboard: digestItems respects routing, skips dismissed", async () => {
    const d = await C.digestItems();
    expect(d.ok).toBe(true);
    // github:Build failed survives; news:Old news is muted-channel; cal:Meeting soon
    // is channel-snoozed; id 11 dismissed. Urgent Server down survives.
    const titles = d.items.map((i) => i.title);
    expect(titles).toContain("Build failed");
    expect(titles).toContain("Server down");
    expect(titles).not.toContain("Old news");
    expect(titles).not.toContain("Meeting soon");
    expect(titles).not.toContain("Gone");
    expect(d.items[0].channelLabel).toBe("GitHub");
    expect((await C.snoozeNotification(7, 30)).ok).toBe(true);
    expect((await C.dismissNotification(7)).ok).toBe(true);
  });

  test("switchboard: quiet hours filter to urgent-only", async () => {
    // 23:30 local is inside 22:00-07:00 quiet hours; stub a clock via query is
    // overkill — call getQuietState with an explicit timestamp instead.
    const q = await C.getQuietState(new Date(2026, 9, 1, 23, 30).getTime());
    expect(q.reachable).toBe(true);
    expect(q.inQuiet).toBe(true);
    expect(q.urgentBreaks).toBe(true);
    const day = await C.getQuietState(new Date(2026, 9, 1, 12, 0).getTime());
    expect(day.inQuiet).toBe(false);
  });

  test("switchboard: channels find/mute/unmute", async () => {
    const f = await C.findChannel("github");
    expect(f.ok).toBe(true);
    expect(f.channel!.id).toBe("github");
    expect(f.channel!.label).toBe("GitHub");
    const byLabel = await C.findChannel("GitHub");
    expect(byLabel.channel!.id).toBe("github");
    expect((await C.findChannel("nope")).ok).toBe(false);
    expect((await C.muteChannel("github", 120)).ok).toBe(true);
    expect((await C.unmuteChannel("github")).ok).toBe(true);
  });

  test("switchboard: urgentSince returns only new urgents", async () => {
    const u = await C.urgentSince(0);
    expect(u.map((n) => n.id).sort((a, b) => a - b)).toEqual([9, 10]);
    const none = await C.urgentSince(4000);
    expect(none).toHaveLength(0);
  });

  test("unreachable app degrades gracefully", async () => {
    process.env.BRIEFING_URL = "http://127.0.0.1:1";
    const r = await C.composeBrief();
    expect(r.ok).toBe(false);
    expect(r.speech).toMatch(/can't reach/i);
    process.env.BRIEFING_URL = B.briefing;
  });
});
