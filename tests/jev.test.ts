// sherry: jev learning engine unit tests.
import { describe, test, expect, beforeEach } from "bun:test";
import {
  kindWeight, recordShown, recordActed,
  learnedRanking, learnedSpeech, __resetJevForTests,
} from "../src/jev";
import { __resetDbForTests } from "../src/db";

beforeEach(() => {
  process.env.SHERRY_DATA = "/tmp/sherry-jev-test-" + Math.random().toString(36).slice(2);
  __resetDbForTests();
  __resetJevForTests();
});

describe("jev", () => {
  test("starts at maximum uncertainty (0.5)", () => {
    expect(kindWeight("waiting_reply")).toBe(0.5);
    expect(kindWeight("no_such_kind")).toBe(0.5);
  });

  test("acting on a kind raises its weight", () => {
    recordShown("waiting_reply");
    recordShown("waiting_reply");
    recordActed("waiting_reply");
    // (1+1)/(2+2) = 0.5 — one act out of two shown
    expect(kindWeight("waiting_reply")).toBe(0.5);
    recordActed("waiting_reply");
    // (2+1)/(2+2) = 0.75
    expect(kindWeight("waiting_reply")).toBe(0.75);
  });

  test("ignored kinds sink below 0.5", () => {
    for (let i = 0; i < 4; i++) recordShown("noisy_channel");
    // (0+1)/(4+2) = 1/6
    expect(kindWeight("noisy_channel")).toBeCloseTo(1 / 6, 5);
  });

  test("learnedRanking orders by weight", () => {
    recordShown("noisy_channel");
    recordShown("noisy_channel");
    recordShown("waiting_reply");
    recordActed("waiting_reply");
    const ranking = learnedRanking();
    expect(ranking[0].kind).toBe("waiting_reply");
    expect(ranking[ranking.length - 1].kind).toBe("noisy_channel");
  });

  test("learnedSpeech is honest when untrained", () => {
    expect(learnedSpeech()).toMatch(/haven't learned/);
  });

  test("learnedSpeech summarizes patterns", () => {
    recordShown("waiting_reply");
    recordShown("waiting_reply");
    recordActed("waiting_reply");
    recordActed("waiting_reply");
    for (let i = 0; i < 4; i++) recordShown("noisy_channel");
    const s = learnedSpeech();
    expect(s).toMatch(/usually act/);
    expect(s).toMatch(/ignore/);
  });
});
