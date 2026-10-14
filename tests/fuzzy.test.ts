// sherry: fuzzy command understanding tests.
import { describe, test, expect } from "bun:test";
import { route } from "../src/router";
import { fuzzyRoute, boundedEdit, stem } from "../src/fuzzy";

describe("fuzzy primitives", () => {
  test("boundedEdit measures typos", () => {
    expect(boundedEdit("brief", "brief", 2)).toBe(0);
    expect(boundedEdit("brif", "brief", 2)).toBe(1);
    expect(boundedEdit("mesage", "message", 2)).toBe(1);
    expect(boundedEdit("xyz", "brief", 1)).toBe(2); // over budget -> maxDist+1
  });

  test("stem normalizes", () => {
    expect(stem("briefing")).toBe("brief");
    expect(stem("messages")).toBe("messag");
    expect(stem("happening")).toBe("happen");
  });
});

describe("fuzzy routing", () => {
  test("typos recover", () => {
    expect(route("brif me").intent).toBe("brief");
    expect(route("mesage shy hello there").intent).toBe("message");
    expect(route("mut github").intent).toBe("mute_channel");
    expect(route("reserch electric cars").intent).toBe("research_start");
  });

  test("paraphrases recover", () => {
    expect(route("give me the rundown").intent).toBe("brief");
    expect(route("what is happening").intent).toBe("digest");
    expect(route("any advice").intent).toBe("suggest");
    expect(route("look up zoning laws").intent).toBe("research_start");
  });

  test("filler words don't block", () => {
    expect(route("could you please brief me now").intent).toBe("brief");
  });

  test("slots survive fuzzy verbs", () => {
    const r = route("mesage shy hello there");
    expect(r.intent).toBe("message");
    expect(r.slots.contact).toBe("shy");
    expect(r.slots.body).toBe("hello there");
  });

  test("ambiguous input stays unknown", () => {
    expect(route("tell me a joke").intent).toBe("unknown");
    expect(route("what is the meaning of life").intent).toBe("unknown");
  });

  test("fuzzy returns confidence", () => {
    const r = fuzzyRoute("brif me");
    expect(r).not.toBeNull();
    expect(r!.confidence).toBeGreaterThan(0);
    expect(r!.confidence).toBeLessThanOrEqual(1);
  });
});
