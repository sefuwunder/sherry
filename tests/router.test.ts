// sherry: router unit tests — pure function, no I/O.
import { describe, test, expect } from "bun:test";
import { route, HELP_SPEECH } from "../src/router";

describe("router", () => {
  test("brief intents", () => {
    for (const t of ["brief me", "Briefing", "morning brief", "how's my day", "what's the news", "headlines"]) {
      expect(route(t).intent).toBe("brief");
    }
  });

  test("myday intents", () => {
    for (const t of ["what's on my plate", "my tasks", "tasks today", "what do I have today"]) {
      expect(route(t).intent).toBe("myday");
    }
  });

  test("add_task with and without project", () => {
    const a = route("add task buy milk to Groceries");
    expect(a.intent).toBe("add_task");
    expect(a.slots.title).toBe("buy milk");
    expect(a.slots.project).toBe("groceries");
    const b = route("add call danyetta");
    expect(b.intent).toBe("add_task");
    expect(b.slots.title).toBe("call danyetta");
    expect(b.slots.project).toBeUndefined();
  });

  test("message intent splits contact and body", () => {
    const r = route("message Shy I'll be late");
    expect(r.intent).toBe("message");
    expect(r.slots.contact).toBe("shy");
    expect(r.slots.body).toBe("i'll be late");
    expect(route("text Danyetta happy birthday").slots.contact).toBe("danyetta");
    expect(route("tell shy call me").intent).toBe("message");
  });

  test("confirm / cancel win as single words", () => {
    expect(route("yes").intent).toBe("confirm");
    expect(route("send it").intent).toBe("confirm");
    expect(route("no").intent).toBe("cancel");
    expect(route("never mind").intent).toBe("cancel");
  });

  test("new_messages", () => {
    for (const t of ["any new messages", "read my messages", "check messages", "unread"]) {
      expect(route(t).intent).toBe("new_messages");
    }
  });

  test("digest", () => {
    for (const t of ["what's new", "anything urgent", "notifications"]) {
      expect(route(t).intent).toBe("digest");
    }
  });

  test("snooze parses durations", () => {
    expect(route("snooze that").slots.minutes).toBe("30");
    expect(route("snooze for 10 minutes").slots.minutes).toBe("10");
    expect(route("snooze that for 2 hours").slots.minutes).toBe("120");
  });

  test("dismiss", () => {
    expect(route("dismiss that").intent).toBe("dismiss");
  });

  test("help + unknown", () => {
    expect(route("help").intent).toBe("help");
    expect(route("what can you do").intent).toBe("help");
    expect(route("tell me a joke about elephants").intent).toBe("unknown");
  });

  test("research_start", () => {
    const r = route("research electric vehicle subsidies");
    expect(r.intent).toBe("research_start");
    expect(r.slots.topic).toBe("electric vehicle subsidies");
    expect(route("look into zoning laws").intent).toBe("research_start");
    expect(route("investigate supply chain delays").slots.topic).toBe("supply chain delays");
  });

  test("research_status", () => {
    expect(route("research status").intent).toBe("research_status");
    expect(route("research update").intent).toBe("research_status");
    expect(route("how's my research").intent).toBe("research_status");
    expect(route("any research running").intent).toBe("research_status");
  });

  test("research_findings", () => {
    const r = route("what did you find on tariffs");
    expect(r.intent).toBe("research_findings");
    expect(r.slots.topic).toBe("tariffs");
    expect(route("summarize the tariff research").slots.topic).toBe("tariff");
    expect(route("what did you find").intent).toBe("research_findings");
    expect(route("research findings").slots.topic).toBeUndefined();
  });

  test("research status wins over research topic", () => {
    expect(route("research status").intent).toBe("research_status");
  });

  test("triage_next", () => {
    expect(route("next").intent).toBe("triage_next");
    expect(route("skip").intent).toBe("triage_next");
  });

  test("what_was_that", () => {
    for (const t of ["what was that", "what's that", "what was the chime", "the chime"]) {
      expect(route(t).intent).toBe("what_was_that");
    }
  });

  test("mute / unmute channel", () => {
    const m1 = route("mute github");
    expect(m1.intent).toBe("mute_channel");
    expect(m1.slots.channel).toBe("github");
    expect(m1.slots.duration).toBe("");
    const m2 = route("mute github for 2 hours");
    expect(m2.slots.duration).toBe("2 hours");
    expect(route("mute github for today").slots.duration).toBe("today");
    const u = route("unmute github");
    expect(u.intent).toBe("unmute_channel");
    expect(u.slots.channel).toBe("github");
  });

  test("cancel covers triage exits", () => {
    expect(route("done").intent).toBe("cancel");
    expect(route("that's all").intent).toBe("cancel");
  });

  test("mute doesn't swallow digest", () => {
    expect(route("what's new").intent).toBe("digest");
    expect(route("mute github").intent).toBe("mute_channel");
  });

  test("opener stripped", () => {
    expect(route("hey sherry, brief me").intent).toBe("brief");
    expect(route("sherry what's new").intent).toBe("digest");
  });

  test("help speech is short", () => {
    expect(HELP_SPEECH.length).toBeLessThan(400);
  });
});
