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
let muted: any[] = [];
let lvRuns: any[] = [];
let lvStarted: string[] = [];

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
    "GET /api/channels": () => j({
      channels: [
        { id: "github", mode: "instant", enabled: 1, min_priority: "low", snoozed_until: 0, meta: { label: "GitHub" } },
      ],
    }),
    "GET /api/settings": () => j({
      settings: { quiet_enabled: "0", quiet_start: "22:00", quiet_end: "07:00", urgent_breaks_quiet: "1" },
    }),
    "GET /api/notifications": () => j({
      notifications: [
        { id: 3, title: "Deploy done", body: "", channel_id: "github", priority: "normal", status: "new", created_at: 1000 },
        { id: 4, title: "PR merged", body: "", channel_id: "github", priority: "normal", status: "new", created_at: 2000 },
        { id: 5, title: "Server down", body: "prod", channel_id: "github", priority: "urgent", status: "new", created_at: 3000 },
      ],
    }),
    "POST /api/notifications/3/snooze": () => j({ notification: { id: 3 } }),
    "POST /api/notifications/4/snooze": () => j({ notification: { id: 4 } }),
    "POST /api/notifications/4/dismiss": () => j({ notification: { id: 4 } }),
    "POST /api/notifications/5/dismiss": () => j({ notification: { id: 5 } }),
    "POST /api/channels/github/snooze": async (req) => {
      const b: any = await req.json();
      muted.push(b);
      return j({ channel: { id: "github" } });
    },
  });

  process.env.BRIEFING_URL = briefing;
  process.env.ASCENT_URL = ascent;
  process.env.RELAY_URL = relay;
  process.env.SWITCHBOARD_URL = sw;

  lvRuns = [
    { id: 1, question: "EV subsidies", status: "done", created_at: 1000, findings: 3, sources: 8 },
    { id: 2, question: "sourdough starters", status: "working", created_at: 2000, findings: 0, sources: 2 },
  ];
  lvStarted = [];
  const lv = stub({
    "GET /api/agent": () => j({ ok: true, runs: lvRuns }),
    "POST /api/agent": async (req) => {
      const b: any = await req.json();
      if (!String(b.question || "").trim()) return j({ ok: false, error: "question is required" }, 400);
      lvStarted.push(String(b.question));
      return j({ ok: true, run_id: 99 }, 202);
    },
    "GET /api/agent/1": () => j({
      ok: true,
      run: {
        id: 1, question: "EV subsidies", status: "done",
        report_md: "# EV subsidies\n\n## Key points\n\n- Subsidies rose 12% in 2025.\n- Three states added rebates.\n- The federal credit expires in 2027.\n\n## Sources\n\n1. [x](http://x)\n",
      },
    }),
    "GET /api/agent/2": () => j({ ok: true, run: { id: 2, question: "sourdough starters", status: "working" } }),
  });
  process.env.LONGVIEW_URL = lv;
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

  test("digest opens triage; next/snooze/dismiss walk it", async () => {
    const { __resetConversationForTests } = await import("../src/app");
    __resetConversationForTests();
    const d: any = await ask("what's new");
    expect(d.intent).toBe("digest");
    expect(d.speech).toMatch(/3 notifications/);
    expect(d.speech).toMatch(/1 of 3/);
    expect(d.speech).toMatch(/Deploy done/);
    expect(d.speech).toMatch(/next, snooze, or dismiss/);

    const n: any = await ask("next");
    expect(n.intent).toBe("triage_next");
    expect(n.speech).toMatch(/2 of 3/);
    expect(n.speech).toMatch(/PR merged/);

    const s: any = await ask("snooze that for 10 minutes");
    expect(s.intent).toBe("snooze");
    expect(s.speech).toMatch(/Snoozed GitHub — "PR merged" for 10 minutes/);
    expect(s.speech).toMatch(/3 of 3/);
    expect(s.speech).toMatch(/Server down/);

    const x: any = await ask("dismiss");
    expect(x.intent).toBe("dismiss");
    expect(x.speech).toMatch(/Dismissed GitHub — "Server down"/);
    expect(x.speech).toMatch(/That's all of them/);

    // triage exhausted: next now asks for a fresh digest
    const n2: any = await ask("next");
    expect(n2.speech).toMatch(/No digest open/);
  });

  test("stop exits triage; snooze with no context asks first", async () => {
    const { __resetConversationForTests } = await import("../src/app");
    __resetConversationForTests();
    await ask("what's new");
    const done: any = await ask("stop");
    expect(done.speech).toMatch(/Done with notifications/);
    const d: any = await ask("snooze that");
    expect(d.speech).toMatch(/Say what's new first/);
  });

  test("mute / unmute channel by voice", async () => {
    const { __resetConversationForTests } = await import("../src/app");
    __resetConversationForTests();
    muted = [];
    const m: any = await ask("mute github for 2 hours");
    expect(m.intent).toBe("mute_channel");
    expect(m.speech).toMatch(/Muted GitHub for 2 hours/);
    expect(muted).toHaveLength(1);
    expect(muted[0].minutes).toBe(120);
    const u: any = await ask("unmute github");
    expect(u.intent).toBe("unmute_channel");
    expect(u.speech).toMatch(/Unmuted GitHub/);
    expect(muted[1].clear).toBe(true);
    const bad: any = await ask("mute nope");
    expect(bad.speech).toMatch(/don't know/);
  });

  test("what was that reads the last chime", async () => {
    const { __resetConversationForTests, __setLastChimedForTests } = await import("../src/app");
    __resetConversationForTests();
    const q: any = await ask("what was that");
    expect(q.intent).toBe("what_was_that");
    expect(q.speech).toMatch(/Nothing chimed/);
    __setLastChimedForTests([{ kind: "switchboard", detail: "GitHub — Server down" }]);
    const q2: any = await ask("what was that");
    expect(q2.speech).toMatch(/That was: GitHub — Server down/);
  });

  test("urgent watcher chimes once for new urgents, then goes quiet", async () => {
    const { __resetConversationForTests, __syncUrgentForTests } = await import("../src/app");
    __resetConversationForTests();
    // silent initial sync marks the current urgent seen without chiming
    expect(await __syncUrgentForTests(true)).toBe(false);
    // nothing new since -> no chime
    expect(await __syncUrgentForTests(false)).toBe(false);
    // fresh watermark -> the existing urgent is "new" -> chimes once
    __resetConversationForTests();
    expect(await __syncUrgentForTests(false)).toBe(true);
    const q: any = await ask("what was that");
    expect(q.speech).toMatch(/That was: GitHub — Server down/);
    // second pass: watermark advanced -> silent
    expect(await __syncUrgentForTests(false)).toBe(false);
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

  test("research_start kicks off a run", async () => {
    const { __resetConversationForTests } = await import("../src/app");
    __resetConversationForTests();
    lvStarted = [];
    const d: any = await ask("research electric vehicle subsidies");
    expect(d.intent).toBe("research_start");
    expect(d.speech).toMatch(/Research started on "electric vehicle subsidies"/);
    expect(d.speech).toMatch(/I'll chime when it's done/);
    expect(lvStarted).toEqual(["electric vehicle subsidies"]);
  });

  test("research_status summarizes running and recent", async () => {
    const d: any = await ask("research status");
    expect(d.intent).toBe("research_status");
    expect(d.speech).toMatch(/Running: "sourdough starters"/);
    expect(d.speech).toMatch(/Recent: "EV subsidies" \(3 findings\)/);
  });

  test("research_findings reads key points aloud", async () => {
    const d: any = await ask("what did you find on EV");
    expect(d.intent).toBe("research_findings");
    expect(d.speech).toMatch(/On "EV subsidies"/);
    expect(d.speech).toMatch(/Subsidies rose 12% in 2025/);
    expect(d.speech).toMatch(/federal credit expires in 2027/);
  });

  test("research_findings with no match says so", async () => {
    const d: any = await ask("what did you find on mars colonies");
    expect(d.speech).toMatch(/No finished research on "mars colonies" yet/);
  });

  test("research completion chimes, what-was-that reveals", async () => {
    const { __resetConversationForTests, __syncUrgentForTests } = await import("../src/app");
    __resetConversationForTests();
    // silent initial sync marks run 2 as working
    expect(await __syncUrgentForTests(true)).toBe(false);
    // run 2 finishes -> chime
    lvRuns.find((r) => r.id === 2)!.status = "done";
    lvRuns.find((r) => r.id === 2)!.findings = 4;
    expect(await __syncUrgentForTests(false)).toBe(true);
    const q: any = await ask("what was that");
    expect(q.speech).toMatch(/Research complete: "sourdough starters" — 4 findings/);
    // restore: no further transitions -> silent
    expect(await __syncUrgentForTests(false)).toBe(false);
    lvRuns.find((r) => r.id === 2)!.status = "working";
    lvRuns.find((r) => r.id === 2)!.findings = 0;
  });

  test("/api/tts/status reports engine state", async () => {
    const r = await handle(new Request("http://x/api/tts/status"));
    const s: any = await r.json();
    expect(typeof s.available).toBe("boolean");
    expect(typeof s.voice).toBe("string");
  });

  test("/api/speak 503s without a voice engine", async () => {
    const saved = process.env.PIPER_BIN;
    delete process.env.PIPER_BIN;
    const r = await handle(new Request("http://x/api/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    }));
    expect(r.status).toBe(503);
    const d: any = await r.json();
    expect(d.ttsMissing).toBe(true);
    if (saved !== undefined) process.env.PIPER_BIN = saved;
  });

  test("/api/speak returns wav with a fake engine", async () => {
    const { mkdtempSync: mk, writeFileSync: wf, chmodSync: ch } = await import("node:fs");
    const { tmpdir: td } = await import("node:os");
    const { join: jn } = await import("node:path");
    const d = mk(jn(td(), "sherry-speak-"));
    // minimal wav the fake copies to --output_file
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]);
    wf(jn(d, "out.wav"), wav);
    wf(jn(d, "fake-piper"), `#!/bin/sh\nout=""; prev=""\nfor a in "$@"; do\nif [ "$prev" = "--output_file" ]; then out="$a"; fi\nprev="$a"\ndone\ncat > /dev/null\ncp "${jn(d, "out.wav")}" "$out"\n`);
    ch(jn(d, "fake-piper"), 0o755);
    const pd = mk(jn(td(), "sherry-piper-"));
    const { mkdirSync: md } = await import("node:fs");
    md(jn(pd, "piper"), { recursive: true });
    wf(jn(pd, "piper", "v.onnx"), "x");
    wf(jn(pd, "piper", "v.onnx.json"), "{}");
    const savedBin = process.env.PIPER_BIN;
    const savedVoice = process.env.PIPER_VOICE;
    const savedData = process.env.SHERRY_DATA;
    process.env.PIPER_BIN = jn(d, "fake-piper");
    process.env.PIPER_VOICE = "v";
    process.env.SHERRY_DATA = pd;
    try {
      const r = await handle(new Request("http://x/api/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello there" }),
      }));
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("audio/wav");
      const bytes = new Uint8Array(await r.arrayBuffer());
      expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x52, 0x49, 0x46, 0x46]);
    } finally {
      if (savedBin !== undefined) process.env.PIPER_BIN = savedBin; else delete process.env.PIPER_BIN;
      if (savedVoice !== undefined) process.env.PIPER_VOICE = savedVoice; else delete process.env.PIPER_VOICE;
      if (savedData !== undefined) process.env.SHERRY_DATA = savedData;
    }
  });
});
