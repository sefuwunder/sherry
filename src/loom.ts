// sherry ↔ loom wiring. Sherry is the voice; loom is the durable thinker.
// "Think about X" submits a job to loom's SQLite-backed thought harness;
// completions surface through Sherry's SSE so the widget speaks them.
// Loom is CLI-only by design, so this shells out to its CLI. Zero deps.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";

function loomRoot(): string {
  return process.env.LOOM_DIR || join(homedir(), "workspace", "your_files", "loom");
}

function loomDbPath(): string {
  const dir = process.env.LOOM_DATA_DIR || join(loomRoot(), "data");
  return join(dir, "loom.db");
}

/** Run the loom CLI and capture stdout. */
async function loomCli(args: string[], timeoutMs = 15000): Promise<{ ok: boolean; out: string; error?: string }> {
  try {
    const proc = Bun.spawn(["bun", join(loomRoot(), "src", "cli.ts"), ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    clearTimeout(timer);
    if (code !== 0) return { ok: false, out: out.trim(), error: err.trim().slice(0, 200) || `exit ${code}` };
    return { ok: true, out: out.trim() };
  } catch (e: any) {
    return { ok: false, out: "", error: String(e?.message || e).slice(0, 200) };
  }
}

export interface LoomJob {
  id: string;
  name: string;
  status: string;
  steps: number;
}

/** Submit a thought to loom. Returns the job id. */
export async function submitThought(goal: string, name?: string): Promise<{ ok: boolean; id?: string; error?: string }> {
  const clean = goal.trim().slice(0, 500);
  if (!clean) return { ok: false, error: "empty" };
  const args = ["submit", clean];
  if (name) args.push("--name", name.slice(0, 60));
  const r = await loomCli(args);
  if (!r.ok) return { ok: false, error: r.error };
  const id = r.out.split("\n")[0].trim();
  if (!id) return { ok: false, error: "no id returned" };
  return { ok: true, id };
}

/** List recent loom jobs (parsed from `loom board`). */
export async function listJobs(): Promise<{ ok: boolean; jobs: LoomJob[]; error?: string }> {
  const r = await loomCli(["board"]);
  if (!r.ok) return { ok: false, jobs: [], error: r.error };
  if (r.out.startsWith("no jobs yet")) return { ok: true, jobs: [] };
  const jobs: LoomJob[] = [];
  for (const line of r.out.split("\n").slice(1)) {
    // id(20) status(10) steps(8) spin(6) name
    const m = line.match(/^(\S+)\s+(\S+)\s+(\d+)\s+\d+\s+(.*)$/);
    if (m) jobs.push({ id: m[1], name: m[4].trim(), status: m[2], steps: Number(m[3]) });
  }
  return { ok: true, jobs };
}

export interface LoomNotice {
  id: number;
  jobId: string;
  kind: string;
  text: string;
}

/** Read undelivered outbox notices WITHOUT marking delivered (unlike the CLI). */
export function peekOutbox(): LoomNotice[] {
  try {
    const db = new Database(loomDbPath(), { readonly: true });
    const rows = db.query(
      `SELECT id, job_id, kind, text FROM outbox WHERE delivered = 0 ORDER BY id`
    ).all() as any[];
    db.close();
    return rows.map((r) => ({ id: r.id, jobId: r.job_id, kind: r.kind, text: String(r.text || "") }));
  } catch {
    return [];
  }
}

export function markOutboxDelivered(ids: number[]): void {
  if (!ids.length) return;
  try {
    const db = new Database(loomDbPath());
    const placeholders = ids.map(() => "?").join(",");
    db.query(`UPDATE outbox SET delivered = 1 WHERE id IN (${placeholders})`).run(...ids);
    db.close();
  } catch { /* non-fatal */ }
}

/** Get a job's result text via `loom status`. */
export async function jobResult(id: string): Promise<{ ok: boolean; text: string }> {
  const r = await loomCli(["status", id]);
  if (!r.ok) return { ok: false, text: "" };
  // status output ends with "result: <text>"
  const m = r.out.match(/result:\s*([\s\S]*)$/);
  const text = (m ? m[1] : "").trim();
  return { ok: true, text: text && text !== "—" ? text : "" };
}

/** Spoken summary of loom state: pending notices + active jobs. */
export async function loomSummary(): Promise<string> {
  const notices = peekOutbox();
  const { ok, jobs } = await listJobs();
  const parts: string[] = [];
  if (notices.length) {
    const kinds = notices.map((n) => n.kind).filter(Boolean);
    parts.push(
      notices.length === 1
        ? `One finished thought${kinds[0] ? ` (${kinds[0]})` : ""}.`
        : `${notices.length} finished thoughts.`
    );
  }
  if (ok) {
    const active = jobs.filter((j) => j.status === "active" || j.status === "pending");
    if (active.length) {
      const names = active.slice(0, 3).map((j) => j.name || j.id.slice(0, 8));
      parts.push(`Still thinking about: ${names.join("; ")}.`);
    } else if (!notices.length) {
      parts.push("Nothing in progress.");
    }
  }
  return parts.join(" ") || "Loom is quiet.";
}
