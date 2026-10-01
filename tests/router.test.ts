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

  test("opener stripped", () => {
    expect(route("hey sherry, brief me").intent).toBe("brief");
    expect(route("sherry what's new").intent).toBe("digest");
  });

  test("help speech is short", () => {
    expect(HELP_SPEECH.length).toBeLessThan(400);
  });
});
