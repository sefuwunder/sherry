// sherry ↔ loom wiring tests.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { route } from "../src/router";

let loomData = "";
let sherryData = "";

beforeAll(() => {
  loomData = mkdtempSync(join(tmpdir(), "loom-test-"));
  sherryData = mkdtempSync(join(tmpdir(), "sherry-loom-"));
  process.env.LOOM_DATA_DIR = loomData;
  process.env.LOOM_DIR = join(process.env.HOME || "/home/hatch", "workspace", "your_files", "loom");
  process.env.SHERRY_DATA = sherryData;
  // Seed a fake loom db with one undelivered outbox notice
  const db = new Database(join(loomData, "loom.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, kind TEXT, text TEXT,
    created_at INTEGER, delivered INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY, name TEXT, status TEXT, created_at INTEGER)`);
  db.query(`INSERT INTO outbox (job_id, kind, text, created_at, delivered)
    VALUES (?, ?, ?, ?, 0)`).run("job123", "conclusion", "The best pricing is tiered.", Date.now());
  db.close();
});
afterAll(() => {
  delete process.env.LOOM_DATA_DIR;
  try { rmSync(loomData, { recursive: true }); } catch {}
  try { rmSync(sherryData, { recursive: true }); } catch {}
});

describe("loom routing", () => {
  test("think/thoughts phrases route correctly", () => {
    expect(route("think about the best pricing model").intent).toBe("think");
    expect(route("think about the best pricing model").slots.goal).toBe("the best pricing model");
    expect(route("ponder whether to expand the menu").intent).toBe("think");
    expect(route("what did loom conclude").intent).toBe("thoughts");
    expect(route("check loom").intent).toBe("thoughts");
    expect(route("any thoughts").intent).toBe("thoughts");
  });
});

describe("loom outbox", () => {
  test("peekOutbox reads without delivering", async () => {
    const { peekOutbox, markOutboxDelivered } = await import("../src/loom");
    const before = peekOutbox();
    expect(before.length).toBe(1);
    expect(before[0].text).toContain("tiered");
    // Still undelivered after peek
    expect(peekOutbox().length).toBe(1);
    markOutboxDelivered(before.map((n) => n.id));
    expect(peekOutbox().length).toBe(0);
  });
});

describe("thoughts intent", () => {
  test("speaks finished thoughts then marks delivered", async () => {
    // Re-seed (previous test consumed it)
    const db = new Database(join(loomData, "loom.db"));
    db.query(`INSERT INTO outbox (job_id, kind, text, created_at, delivered)
      VALUES (?, ?, ?, ?, 0)`).run("job456", "conclusion", "Expand the juice menu.", Date.now());
    db.close();
    const { handle, __resetConversationForTests } = await import("../src/app");
    __resetConversationForTests();
    const r = await handle(new Request("http://x/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "what did loom conclude" }),
    }));
    const d: any = await r.json();
    expect(d.intent).toBe("thoughts");
    // jobResult will fail (no real loom job), so it falls back to outbox text
    expect(d.speech).toMatch(/juice menu|finished|conclusion/i);
    // Now delivered
    const { peekOutbox } = await import("../src/loom");
    expect(peekOutbox().length).toBe(0);
  });
});
